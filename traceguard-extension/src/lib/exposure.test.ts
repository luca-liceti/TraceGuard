/**
 * =============================================================================
 * FOOTPRINT LEDGER TESTS
 * =============================================================================
 *
 * The ledger's whole value is that its claims are checkable. These tests lock in
 * the two things that make that true:
 *
 * 1. THE RULES - a handover is only flagged "surprising" for a reason we can
 *    explain in a sentence (visited once, dormant, entered while the site scored
 *    poorly, or no longer in the cache).
 * 2. THE CALCULATION - counts, ordering and de-duplication are exact, so a row
 *    that says "23 sites" really is 23 sites.
 *
 * Everything is driven through an injected `now`, so no test depends on the
 * wall clock.
 * =============================================================================
 */
import { describe, it, expect } from 'vitest';
import {
    buildExposureReport,
    canonicalOrganization,
    categoryLabelKey,
    SINGLE_VISIT_THRESHOLD,
    DORMANT_DAYS,
    LOW_TRUST_WSS,
    MAX_WATCHERS,
} from './exposure';
import type { CrossSiteExposure, PIIDetectionEvent, SiteRiskData, TrackerDetail } from './types';

// Deterministic clock: 2026-09-11.
const NOW = new Date(2026, 8, 11, 12, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function makeSite(domain: string, overrides: Partial<SiteRiskData> = {}): SiteRiskData {
    return {
        domain,
        wss: 90,
        breakdown: { reputation: 100, tracking: 90, cookies: 90, input: 90, policy: 90 },
        lastAnalyzed: NOW - DAY,
        visitCount: 10,
        ...overrides,
    };
}

function makeTracker(organization: string | null, domain: string, category: TrackerDetail['category'] = 'advertising'): TrackerDetail {
    return {
        url: `https://${domain}/t.js`,
        domain,
        organization,
        category,
        type: 'script',
        status: 'active',
        source: 'dom',
        prevalence: null,
        fingerprinting: null,
    };
}

function makeEvent(site: string, fieldType: string, timestamp: number, siteWSS = 90): PIIDetectionEvent {
    return { site, fieldType, timestamp, siteWSS, sensitivity: 'MEDIUM', scoreImpact: -2 };
}

/** Wrap tracker items into the enrichedDetails shape the ledger reads. */
function withTrackers(domain: string, items: TrackerDetail[], overrides: Partial<SiteRiskData> = {}): SiteRiskData {
    const site = makeSite(domain, overrides);
    return {
        ...site,
        enrichedDetails: {
            cookies: { items: [], summary: { total: 0, active: 0, blocked: 0, byCategory: {} } },
            trackers: { items, summary: { total: items.length, active: items.length, blocked: 0, byCategory: {} } },
            networkRequests: { items: [], summary: { total: 0, thirdParty: 0, blocked: 0, trackerRequests: 0 } },
            headers: { items: [], summary: { score: 0, present: 0, missing: 0, grade: 'F' } },
            fingerprinting: { items: [], summary: { totalAttempts: 0, techniques: [], riskLevel: 'none' } },
            capturedAt: NOW,
        },
    } as SiteRiskData;
}

describe('buildExposureReport', () => {
    it('reports no data for empty input', () => {
        const report = buildExposureReport({ now: NOW });
        expect(report.hasData).toBe(false);
        expect(report.handedOver).toEqual([]);
        expect(report.watchers).toEqual([]);
        expect(report.totals).toEqual({ fieldTypes: 0, domains: 0, organizations: 0, surprising: 0, sitesVisited: 0 });
    });

    it('groups handovers by field type and de-duplicates domains', () => {
        const exposure: CrossSiteExposure = {
            email: ['a.com', 'b.com', 'a.com'],
            password: ['a.com'],
        };

        const report = buildExposureReport({ exposure, now: NOW });

        expect(report.handedOver).toHaveLength(2);
        const email = report.handedOver.find(g => g.fieldType === 'email')!;
        expect(email.siteCount).toBe(2);
        expect(email.sites.map(s => s.domain).sort()).toEqual(['a.com', 'b.com']);
        // Distinct domains across all field types, not the sum of the groups.
        expect(report.totals.domains).toBe(2);
        expect(report.totals.fieldTypes).toBe(2);
    });

    it('survives malformed storage without throwing', () => {
        const report = buildExposureReport({
            // A field whose value is not an array, a blank domain, and junk events.
            exposure: { email: ['ok.com', '', null as unknown as string], broken: 'nope' as unknown as string[] },
            piiEvents: [null as unknown as PIIDetectionEvent, { site: 'x.com' } as PIIDetectionEvent],
            now: NOW,
        });

        const email = report.handedOver.find(g => g.fieldType === 'email')!;
        expect(email.sites.map(s => s.domain)).toEqual(['ok.com']);
        expect(report.handedOver.find(g => g.fieldType === 'broken')).toBeUndefined();
    });

    it('flags a domain visited only once', () => {
        const report = buildExposureReport({
            exposure: { email: ['once.com'] },
            siteCache: { 'once.com': makeSite('once.com', { visitCount: SINGLE_VISIT_THRESHOLD }) },
            now: NOW,
        });

        const site = report.handedOver[0].sites[0];
        expect(site.surprising).toBe(true);
        expect(site.reasons).toContain('single-visit');
    });

    it('flags a domain not visited in a long time', () => {
        const report = buildExposureReport({
            exposure: { email: ['old.com'] },
            siteCache: {
                'old.com': makeSite('old.com', {
                    visitCount: 40,
                    lastAnalyzed: NOW - (DORMANT_DAYS + 30) * DAY,
                }),
            },
            now: NOW,
        });

        expect(report.handedOver[0].sites[0].reasons).toContain('dormant');
    });

    it('flags a handover made while the site scored poorly, even if the site now scores well', () => {
        const report = buildExposureReport({
            exposure: { password: ['risky.com'] },
            // The cache has since improved the site's score to 95.
            siteCache: { 'risky.com': makeSite('risky.com', { wss: 95 }) },
            piiEvents: [makeEvent('risky.com', 'password', NOW - DAY, LOW_TRUST_WSS - 1)],
            now: NOW,
        });

        const site = report.handedOver[0].sites[0];
        expect(site.surprising).toBe(true);
        expect(site.reasons).toContain('low-trust');
    });

    it('flags a domain with no site-cache entry as no longer visited', () => {
        const report = buildExposureReport({
            exposure: { email: ['gone.com'] },
            siteCache: {},
            now: NOW,
        });

        const site = report.handedOver[0].sites[0];
        expect(site.reasons).toContain('not-recently-visited');
        expect(site.visitCount).toBe(0);
        expect(site.wss).toBeNull();
    });

    it('does not flag a repeated, recent, well-scoring handover', () => {
        const report = buildExposureReport({
            exposure: { email: ['bank.com'] },
            siteCache: { 'bank.com': makeSite('bank.com', { visitCount: 120, lastAnalyzed: NOW - DAY, wss: 95 }) },
            piiEvents: [makeEvent('bank.com', 'email', NOW - 2 * DAY, 95)],
            now: NOW,
        });

        const site = report.handedOver[0].sites[0];
        expect(site.surprising).toBe(false);
        expect(site.reasons).toEqual([]);
    });

    it('takes first and last seen from the PII events', () => {
        const report = buildExposureReport({
            exposure: { email: ['a.com'] },
            siteCache: { 'a.com': makeSite('a.com') },
            piiEvents: [
                makeEvent('a.com', 'email', NOW - 10 * DAY),
                makeEvent('a.com', 'email', NOW - 1 * DAY),
                makeEvent('a.com', 'email', NOW - 5 * DAY),
            ],
            now: NOW,
        });

        const site = report.handedOver[0].sites[0];
        expect(site.firstSeen).toBe(NOW - 10 * DAY);
        expect(site.lastSeen).toBe(NOW - 1 * DAY);
    });

    it('orders the findings first within a group, and leads with the group that has the most', () => {
        const report = buildExposureReport({
            exposure: {
                email: ['known.com', 'forgotten.com'],
                password: ['old1.com', 'old2.com'],
            },
            siteCache: {
                // Visited often, recently, and trusted: not the story.
                'known.com': makeSite('known.com', { visitCount: 50, lastAnalyzed: NOW - DAY, wss: 95 }),
                // Visited once: the story.
                'forgotten.com': makeSite('forgotten.com', { visitCount: 1 }),
                // Two dormant entries.
                'old1.com': makeSite('old1.com', { visitCount: 20, lastAnalyzed: NOW - 400 * DAY }),
                'old2.com': makeSite('old2.com', { visitCount: 20, lastAnalyzed: NOW - 400 * DAY }),
            },
            now: NOW,
        });

        // password has 2 findings, email has 1 -> password leads.
        expect(report.handedOver[0].fieldType).toBe('password');
        expect(report.handedOver[0].surprisingCount).toBe(2);

        const email = report.handedOver.find(g => g.fieldType === 'email')!;
        expect(email.sites[0].domain).toBe('forgotten.com');
        expect(email.sites[0].surprising).toBe(true);
        expect(email.sites[email.sites.length - 1].domain).toBe('known.com');
        expect(report.totals.surprising).toBe(3);
    });
});

describe('watchers', () => {
    it('aggregates by organization and counts a site once, however many trackers it loads', () => {
        const report = buildExposureReport({
            siteCache: {
                'a.com': withTrackers('a.com', [
                    makeTracker('Google LLC', 'google-analytics.com'),
                    makeTracker('Google LLC', 'doubleclick.net'),
                    makeTracker('Meta Platforms, Inc.', 'facebook.net', 'social'),
                ]),
                'b.com': withTrackers('b.com', [
                    makeTracker('Google LLC', 'googletagmanager.com', 'analytics'),
                ]),
            },
            now: NOW,
        });

        const google = report.watchers.find(w => w.organization === 'Google')!;
        expect(google.siteCount).toBe(2);      // two sites, not three tracker hits
        expect(google.trackerCount).toBe(3);
        expect(google.domains).toEqual(['a.com', 'b.com']);
        expect(google.categories).toEqual(['advertising', 'analytics']);

        const meta = report.watchers.find(w => w.organization === 'Meta')!;
        expect(meta.siteCount).toBe(1);
        expect(meta.categories).toEqual(['social']);

        expect(report.totals.organizations).toBe(2);
    });

    it('ranks by how many of your sites they covered, not by tracker volume', () => {
        const report = buildExposureReport({
            siteCache: {
                'a.com': withTrackers('a.com', [makeTracker('Wide', 'w1.com')]),
                'b.com': withTrackers('b.com', [makeTracker('Wide', 'w2.com')]),
                'c.com': withTrackers('c.com', [makeTracker('Wide', 'w3.com')]),
                // Noisy on one site only.
                'd.com': withTrackers('d.com', [
                    makeTracker('Noisy', 'n1.com'),
                    makeTracker('Noisy', 'n2.com'),
                    makeTracker('Noisy', 'n3.com'),
                    makeTracker('Noisy', 'n4.com'),
                ]),
            },
            now: NOW,
        });

        expect(report.watchers[0].organization).toBe('Wide');
        expect(report.watchers[0].siteCount).toBe(3);
        expect(report.watchers[1].organization).toBe('Noisy');
    });

    it('ignores trackers with no organization and sites with no enriched data', () => {
        const report = buildExposureReport({
            siteCache: {
                'a.com': withTrackers('a.com', [makeTracker(null, 'unknown.com')]),
                'b.com': makeSite('b.com'),
            },
            now: NOW,
        });

        expect(report.watchers).toEqual([]);
        expect(report.hasData).toBe(false);
    });

    it('caps the list so the long tail does not drown the finding', () => {
        const siteCache: Record<string, SiteRiskData> = {};
        for (let i = 0; i < MAX_WATCHERS + 5; i++) {
            siteCache[`s${i}.com`] = withTrackers(`s${i}.com`, [makeTracker(`Org ${i}`, `t${i}.com`)]);
        }

        const report = buildExposureReport({ siteCache, now: NOW });

        expect(report.watchers).toHaveLength(MAX_WATCHERS);
        // The total still reports everything we saw.
        expect(report.totals.organizations).toBe(MAX_WATCHERS + 5);
    });
});

describe('determinism', () => {
    it('produces the same report for the same inputs and clock', () => {
        const input = {
            exposure: { email: ['a.com', 'b.com'], password: ['c.com'] } as CrossSiteExposure,
            piiEvents: [makeEvent('a.com', 'email', NOW - DAY)],
            siteCache: {
                'a.com': withTrackers('a.com', [makeTracker('Google LLC', 'g.com')]),
                'b.com': makeSite('b.com', { visitCount: 1 }),
                'c.com': makeSite('c.com'),
            },
            now: NOW,
        };

        expect(buildExposureReport(input)).toEqual(buildExposureReport(input));
    });
});

describe('canonicalOrganization', () => {
    it('collapses the several names one company is reported under', () => {
        expect(canonicalOrganization('Google')).toBe('Google');
        expect(canonicalOrganization('Google LLC')).toBe('Google');
        expect(canonicalOrganization('Meta')).toBe('Meta');
        expect(canonicalOrganization('Meta Platforms, Inc.')).toBe('Meta');
        expect(canonicalOrganization('Amazon.com, Inc.')).toBe('Amazon');
        expect(canonicalOrganization('Cloudflare, Inc.')).toBe('Cloudflare');
    });

    it('preserves brand casing rather than title-casing', () => {
        expect(canonicalOrganization('LiveRamp')).toBe('LiveRamp');
        expect(canonicalOrganization('reddit')).toBe('Reddit');
        expect(canonicalOrganization('OneTrust')).toBe('OneTrust');
    });

    it('strips a legal suffix from names it does not know', () => {
        expect(canonicalOrganization('Hotjar Ltd')).toBe('Hotjar');
        expect(canonicalOrganization('Acme GmbH')).toBe('Acme');
    });

    it('leaves a brand whose own name ends in those letters alone', () => {
        // No whitespace or comma before the suffix, so this must not be stripped.
        expect(canonicalOrganization('Grab')).toBe('Grab');
    });

    it('handles empty input without inventing a name', () => {
        expect(canonicalOrganization('')).toBe('');
        expect(canonicalOrganization(null)).toBe('');
        expect(canonicalOrganization(undefined)).toBe('');
    });
});

describe('categoryLabelKey', () => {
    it('maps the tracker databases\' own names onto readable labels', () => {
        expect(categoryLabelKey('FingerprintingGeneral')).toBe('Fingerprinting');
        expect(categoryLabelKey('ConsentManagers')).toBe('Consent managers');
        expect(categoryLabelKey('advertising')).toBe('Advertising');
        expect(categoryLabelKey('cdn')).toBe('CDN');
        expect(categoryLabelKey('sso')).toBe('Single sign-on');
    });

    it('falls back to a spaced, capitalised form, never raw camel case', () => {
        expect(categoryLabelKey('SomeNewThing')).toBe('Some new thing');
        expect(categoryLabelKey('')).toBe('Unknown');
        expect(categoryLabelKey(null)).toBe('Unknown');
    });
});

describe('watchers merged from split organization names', () => {
    it('counts one company once, even when the databases disagree on its name', () => {
        const report = buildExposureReport({
            siteCache: {
                'a.com': withTrackers('a.com', [makeTracker('Google LLC', 'g1.com')]),
                'b.com': withTrackers('b.com', [makeTracker('Google', 'g2.com')]),
                'c.com': withTrackers('c.com', [makeTracker('Meta', 'm1.com')]),
                'd.com': withTrackers('d.com', [makeTracker('Meta Platforms, Inc.', 'm2.com', 'social')]),
            },
            now: NOW,
        });

        expect(report.watchers).toHaveLength(2);

        const google = report.watchers.find(w => w.organization === 'Google')!;
        expect(google.siteCount).toBe(2);

        const meta = report.watchers.find(w => w.organization === 'Meta')!;
        expect(meta.siteCount).toBe(2);
        expect(report.totals.organizations).toBe(2);
    });
});
