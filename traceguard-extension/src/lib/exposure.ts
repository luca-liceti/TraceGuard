/**
 * =============================================================================
 * FOOTPRINT LEDGER - Aggregating What You Have Handed Over, and to Whom
 * =============================================================================
 *
 * WHAT THIS FILE DOES:
 * Turns three things the extension already stores into two plain-language lists
 * about the user's own footprint, rather than about the websites themselves:
 *
 *   1. "What you handed over" - for each kind of personal data (email, password,
 *      card...), which domains hold it, when it was first and last seen, and
 *      whether the entry is SURPRISING.
 *   2. "Who has seen you" - which tracker organizations (parent companies from
 *      DuckDuckGo Tracker Radar) appeared across the sites you visited, ranked by
 *      how many of your sites each one covered.
 *
 * WHY IT IS A PURE FUNCTION:
 * No `chrome.*` calls, no React, no I/O. Everything comes in as arguments and
 * goes out as a plain object, so the whole aggregation is unit-testable and
 * deterministic. The hook in `useStorage.ts` is responsible for reading and
 * decrypting the underlying storage; the page is responsible for rendering.
 *
 * INPUTS (all already stored and encrypted elsewhere):
 *   - `crossSiteExposure` - `{ [fieldType]: string[] }`, field type to domains.
 *   - `piiDetections`     - `PIIDetectionEvent[]` (capped at 100 by the
 *                           background worker), used for timestamps and for the
 *                           site's safety score at the moment of entry.
 *   - `siteCache`         - `Record<domain, SiteRiskData>`, used for visit counts
 *                           and for the enriched tracker organizations.
 *
 * IMPORTANT: nothing here is a judgement about whether a site is "bad". It is a
 * record of what the user did. The `surprising` flag only highlights entries the
 * user is most likely to have forgotten; every flag carries a human-readable
 * reason so the UI can explain it and the user can judge it.
 * =============================================================================
 */

import type { CrossSiteExposure, PIIDetectionEvent, SiteRiskData } from './types';

// =============================================================================
// TUNING CONSTANTS
// These decide what counts as "surprising". They are deliberately conservative:
// flagging something the user knowingly did is noise, and noise makes the whole
// list ignorable. Keep them explainable and keep them in one place.
// =============================================================================

/** A domain visited once is more likely to have been forgotten than a daily one. */
export const SINGLE_VISIT_THRESHOLD = 1;

/** Not visited (or analysed) in this many days reads as "forgotten". */
export const DORMANT_DAYS = 180;

/** Below this WSS at the moment of entry, the handover is flagged as low-trust. */
export const LOW_TRUST_WSS = 50;

/** How many watchers to surface. The long tail is not informative. */
export const MAX_WATCHERS = 25;

// =============================================================================
// OUTPUT TYPES
// Derived, not stored - these never touch chrome.storage.
// =============================================================================

/** Why a particular handover was flagged as surprising. */
export type SurpriseReason =
    | 'single-visit'        // the site was visited only once
    | 'dormant'             // no visit recorded in a long time
    | 'low-trust'           // data was entered while the site scored poorly
    | 'not-recently-visited'; // no current site-cache entry at all

/** One domain that received one kind of personal data. */
export interface ExposureSite {
    domain: string;
    /** First time we recorded an entry of this data type here, or null if unknown. */
    firstSeen: number | null;
    /** Most recent entry of this data type here, or null if unknown. */
    lastSeen: number | null;
    /** Visits recorded in the site cache; 0 when the domain is no longer cached. */
    visitCount: number;
    /** Site safety score from the cache, or null when the domain is not cached. */
    wss: number | null;
    /** True when at least one reason applies. */
    surprising: boolean;
    /** Every reason that applies, so the UI can explain the flag. */
    reasons: SurpriseReason[];
}

/** All the domains holding one kind of personal data. */
export interface HandoverGroup {
    fieldType: string;
    sites: ExposureSite[];
    siteCount: number;
    surprisingCount: number;
}

/** One tracker organization, and how much of the user's browsing it covered. */
export interface Watcher {
    organization: string;
    /** How many distinct sites you visited loaded this organization's trackers. */
    siteCount: number;
    /** Total tracker resources observed from this organization. */
    trackerCount: number;
    /** Tracker categories seen for this organization, sorted. */
    categories: string[];
    /** The domains it was seen on, sorted. */
    domains: string[];
}

/** The complete ledger. */
export interface ExposureReport {
    handedOver: HandoverGroup[];
    watchers: Watcher[];
    totals: {
        /** Distinct kinds of personal data recorded. */
        fieldTypes: number;
        /** Distinct domains that hold at least one kind of data. */
        domains: number;
        /** Distinct tracker organizations seen. */
        organizations: number;
        /** Entries flagged as surprising across all groups. */
        surprising: number;
        /** Sites with a cached analysis - the denominator for "how much of your browsing". */
        sitesVisited: number;
    };
    /** False when there is nothing to show yet (fresh install). */
    hasData: boolean;
}

export interface BuildExposureReportInput {
    exposure?: CrossSiteExposure | null;
    piiEvents?: PIIDetectionEvent[] | null;
    siteCache?: Record<string, SiteRiskData> | null;
    /** Injectable clock, for deterministic tests. Defaults to Date.now(). */
    now?: number;
}

// =============================================================================
// HELPERS
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** Last known activity for a cached site, preferring the real visit time. */
function lastActivityOf(site: SiteRiskData | undefined): number | null {
    if (!site) return null;
    const raw = site.lastVisit ?? site.lastAnalyzed;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
        const parsed = new Date(raw).getTime();
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

/**
 * Decide whether a single handover is likely to be forgotten, and why.
 * Every branch is a rule a user could be shown in a sentence.
 */
function judge(
    domain: string,
    site: SiteRiskData | undefined,
    minWssAtEntry: number | null,
    now: number
): SurpriseReason[] {
    const reasons: SurpriseReason[] = [];

    if (!site) {
        // Nothing in the cache: we have no record of visiting it recently, which
        // is exactly the "wait, that site still has my email?" case.
        reasons.push('not-recently-visited');
    } else {
        if (typeof site.visitCount === 'number' && site.visitCount <= SINGLE_VISIT_THRESHOLD) {
            reasons.push('single-visit');
        }
        const last = lastActivityOf(site);
        if (last !== null && now - last >= DORMANT_DAYS * DAY_MS) {
            reasons.push('dormant');
        }
    }

    // The score at the moment of entry is the more honest signal when we have it;
    // the cached score is the fallback.
    const score = minWssAtEntry ?? site?.wss;
    if (typeof score === 'number' && score < LOW_TRUST_WSS) {
        reasons.push('low-trust');
    }

    return reasons;
}

// =============================================================================
// ORGANIZATION NORMALIZATION
// The tracker databases report one company under several names - "Google" and
// "Google LLC", "Meta" and "Meta Platforms, Inc.". Left alone, a single company
// splits into several rows and the "on N of your sites" count comes out too low,
// which is the one number this list exists to show.
//
// This is best-effort and deliberately conservative: an alias table for the
// companies that actually appear, plus trailing legal-suffix stripping for the
// rest. Unknown names are left alone rather than re-cased, because brands like
// "LiveRamp" and "OneTrust" would be mangled by naive title-casing.
// =============================================================================

/** Keyed by lower-cased, whitespace-collapsed name. */
const ORG_ALIASES: Record<string, string> = {
    'google': 'Google',
    'google llc': 'Google',
    'google inc': 'Google',
    'google ireland limited': 'Google',
    'meta': 'Meta',
    'meta platforms': 'Meta',
    'meta platforms, inc.': 'Meta',
    'meta platforms inc': 'Meta',
    'facebook': 'Meta',
    'facebook inc': 'Meta',
    'amazon': 'Amazon',
    'amazon.com': 'Amazon',
    'amazon.com, inc.': 'Amazon',
    'amazon technologies': 'Amazon',
    'cloudflare': 'Cloudflare',
    'cloudflare, inc.': 'Cloudflare',
    'reddit': 'Reddit',
    'liveramp': 'LiveRamp',
    'liveramp, inc.': 'LiveRamp',
    'onetrust': 'OneTrust',
    'onetrust, llc': 'OneTrust',
    'the trade desk': 'The Trade Desk',
    'the trade desk, inc.': 'The Trade Desk',
};

const LEGAL_SUFFIXES = [
    'incorporated', 'corporation', 'company', 'limited', 'holdings',
    'inc', 'llc', 'ltd', 'corp', 'gmbh', 'plc', 'spa', 'pte', 'ag', 'oy', 'ab',
];

// Only strips a suffix preceded by a comma or whitespace, so single-word brand
// names that merely end in the same letters ("Grab" vs " AG") are left intact.
const LEGAL_SUFFIX_PATTERN = new RegExp(
    `[,\\s]+(${LEGAL_SUFFIXES.map(s => s.replace(/\./g, '\\.')).join('|')})\\.?$`,
    'i'
);

function orgKey(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function stripLegalSuffix(name: string): string {
    let current = name.trim();
    for (let i = 0; i < 3; i++) {
        const next = current.replace(LEGAL_SUFFIX_PATTERN, '').trim();
        if (!next || next === current) break;
        current = next;
    }
    return current;
}

/**
 * Collapse the several names one company is reported under into one label.
 * Returns an empty string for missing input.
 */
export function canonicalOrganization(raw: string | null | undefined): string {
    if (!raw) return '';
    const direct = ORG_ALIASES[orgKey(raw)];
    if (direct) return direct;

    const stripped = stripLegalSuffix(raw);
    if (!stripped) return raw.trim();
    return ORG_ALIASES[orgKey(stripped)] ?? stripped;
}

// =============================================================================
// CATEGORY LABELS
// The enriched tracker data carries the databases' own category names
// ("FingerprintingGeneral", "ConsentManagers"). They are readable enough for a
// log but not for a badge, and not translatable. Map them onto a small, known
// set of labels; anything unrecognised falls back to a spaced, capitalised form
// of whatever arrived.
// =============================================================================

const CATEGORY_LABELS: Record<string, string> = {
    ad: 'Advertising',
    ads: 'Advertising',
    advertising: 'Advertising',
    analytics: 'Analytics',
    social: 'Social',
    content: 'Content',
    cdn: 'CDN',
    fingerprinting: 'Fingerprinting',
    fingerprintinggeneral: 'Fingerprinting',
    consentmanager: 'Consent managers',
    consentmanagers: 'Consent managers',
    cryptomining: 'Cryptomining',
    email: 'Email',
    sso: 'Single sign-on',
    unknown: 'Unknown',
};

/** Human-readable, translatable label for a raw tracker category. */
export function categoryLabelKey(raw: string | null | undefined): string {
    if (!raw) return 'Unknown';
    const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (CATEGORY_LABELS[key]) return CATEGORY_LABELS[key];

    // "SomeNewCategory" -> "Some new category".
    const spaced = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    if (!spaced) return 'Unknown';
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Build the footprint ledger from already-stored data.
 *
 * Pure and deterministic: the same inputs and the same `now` always produce the
 * same report.
 */
export function buildExposureReport(input: BuildExposureReportInput): ExposureReport {
    const exposure = input.exposure ?? {};
    const piiEvents = input.piiEvents ?? [];
    const siteCache = input.siteCache ?? {};
    const now = input.now ?? Date.now();

    // -------------------------------------------------------------------------
    // Index the PII events by field type + domain, for dates and entry-time score
    // -------------------------------------------------------------------------
    const eventsByHandover = new Map<string, { first: number; last: number; minWss: number | null }>();

    for (const event of piiEvents) {
        if (!event || typeof event.site !== 'string' || typeof event.fieldType !== 'string') continue;
        if (typeof event.timestamp !== 'number') continue;

        const key = `${event.fieldType}\u0000${event.site}`;
        const existing = eventsByHandover.get(key);

        if (!existing) {
            eventsByHandover.set(key, {
                first: event.timestamp,
                last: event.timestamp,
                minWss: typeof event.siteWSS === 'number' ? event.siteWSS : null,
            });
        } else {
            existing.first = Math.min(existing.first, event.timestamp);
            existing.last = Math.max(existing.last, event.timestamp);
            if (typeof event.siteWSS === 'number') {
                existing.minWss = existing.minWss === null
                    ? event.siteWSS
                    : Math.min(existing.minWss, event.siteWSS);
            }
        }
    }

    // -------------------------------------------------------------------------
    // "What you handed over"
    // -------------------------------------------------------------------------
    const handedOver: HandoverGroup[] = [];
    const allDomains = new Set<string>();
    let totalSurprising = 0;

    for (const [fieldType, rawDomains] of Object.entries(exposure)) {
        if (!Array.isArray(rawDomains)) continue;

        const sites: ExposureSite[] = [];
        const seen = new Set<string>();

        for (const domain of rawDomains) {
            if (typeof domain !== 'string' || domain.length === 0) continue;
            if (seen.has(domain)) continue;
            seen.add(domain);
            allDomains.add(domain);

            const site = siteCache[domain];
            const timing = eventsByHandover.get(`${fieldType}\u0000${domain}`);
            const reasons = judge(domain, site, timing?.minWss ?? null, now);

            sites.push({
                domain,
                firstSeen: timing?.first ?? null,
                lastSeen: timing?.last ?? null,
                visitCount: typeof site?.visitCount === 'number' ? site.visitCount : 0,
                wss: typeof site?.wss === 'number' ? site.wss : null,
                surprising: reasons.length > 0,
                reasons,
            });
        }

        if (sites.length === 0) continue;

        // Surprising first (that is the finding), then most recently seen.
        sites.sort((a, b) => {
            if (a.surprising !== b.surprising) return a.surprising ? -1 : 1;
            const aLast = a.lastSeen ?? -1;
            const bLast = b.lastSeen ?? -1;
            if (aLast !== bLast) return bLast - aLast;
            return a.domain.localeCompare(b.domain);
        });

        const surprisingCount = sites.filter(s => s.surprising).length;
        totalSurprising += surprisingCount;

        handedOver.push({
            fieldType,
            sites,
            siteCount: sites.length,
            surprisingCount,
        });
    }

    // The group with the most findings leads; ties by breadth.
    handedOver.sort((a, b) => {
        if (a.surprisingCount !== b.surprisingCount) return b.surprisingCount - a.surprisingCount;
        if (a.siteCount !== b.siteCount) return b.siteCount - a.siteCount;
        return a.fieldType.localeCompare(b.fieldType);
    });

    // -------------------------------------------------------------------------
    // "Who has seen you"
    // Aggregated from the enriched tracker items. One site counts once per
    // organization, so `siteCount` means "how many of your sites loaded them".
    // -------------------------------------------------------------------------
    const watcherMap = new Map<string, { sites: Set<string>; trackerCount: number; categories: Set<string> }>();

    for (const [domain, site] of Object.entries(siteCache)) {
        const items = site?.enrichedDetails?.trackers?.items;
        if (!items || items.length === 0) continue;

        // Collapse repeated hits from the same organization on one page.
        const perSite = new Map<string, { count: number; categories: Set<string> }>();

        for (const item of items) {
            const organization = canonicalOrganization(item?.organization);
            if (!organization) continue;

            const entry = perSite.get(organization) ?? { count: 0, categories: new Set<string>() };
            entry.count += 1;
            if (item.category) entry.categories.add(item.category);
            perSite.set(organization, entry);
        }

        for (const [organization, entry] of perSite) {
            const watcher = watcherMap.get(organization) ?? {
                sites: new Set<string>(),
                trackerCount: 0,
                categories: new Set<string>(),
            };
            watcher.sites.add(domain);
            watcher.trackerCount += entry.count;
            for (const category of entry.categories) watcher.categories.add(category);
            watcherMap.set(organization, watcher);
        }
    }

    const watchers: Watcher[] = [...watcherMap.entries()]
        .map(([organization, data]) => ({
            organization,
            siteCount: data.sites.size,
            trackerCount: data.trackerCount,
            categories: [...data.categories].sort(),
            domains: [...data.sites].sort(),
        }))
        // Breadth first: "on 34 of your sites" is the meaningful fact, not volume.
        .sort((a, b) => {
            if (a.siteCount !== b.siteCount) return b.siteCount - a.siteCount;
            if (a.trackerCount !== b.trackerCount) return b.trackerCount - a.trackerCount;
            return a.organization.localeCompare(b.organization);
        })
        .slice(0, MAX_WATCHERS);

    return {
        handedOver,
        watchers,
        totals: {
            fieldTypes: handedOver.length,
            domains: allDomains.size,
            organizations: watcherMap.size,
            surprising: totalSurprising,
            sitesVisited: Object.keys(siteCache).length,
        },
        hasData: handedOver.length > 0 || watchers.length > 0,
    };
}
