import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the bundled seed database so tests control exactly what "known" ratings
// exist without hitting chrome-extension:// URLs in Node's fetch.
vi.mock('./services/database-loader', () => ({
    getTosDRMap: vi.fn().mockResolvedValue({}),
}));

import { checkTosDR, clearTosDRCache } from './tosdr-api';
import { getTosDRMap } from './services/database-loader';

describe('checkTosDR', () => {
    beforeEach(() => {
        // Module-level cache survives between tests; reset so each test reads
        // the storage it seeded.
        clearTosDRCache();
        vi.mocked(getTosDRMap).mockResolvedValue({});
    });

    it('returns a local fallback for an unknown domain when cloud is disabled', async () => {
        // Cloud ToS;DR defaults to off; with no seed/cache hit the result must
        // fall back without making any network request.
        const result = await checkTosDR('https://totally-unknown-domain-xyz.com');
        expect(result.found).toBe(false);
        expect(result.source).toBe('fallback');
    });

    it('does not let a negative cache entry shadow a bundled seed rating', async () => {
        // Regression: a failed cloud lookup cached "not found" for a domain
        // that the bundled catalog actually rates. Before the fix this hid the
        // known rating for up to refreshDays (7 days).
        await chrome.storage.local.set({
            tosdr_cache: {
                'google.com': {
                    data: { found: false, score: 0, source: 'fallback' },
                    timestamp: Date.now(), // fresh negative
                },
            },
        });
        vi.mocked(getTosDRMap).mockResolvedValue({
            'google.com': {
                found: true,
                grade: 'E',
                score: 20,
                source: 'tosdr-local',
                serviceName: 'Google',
                serviceId: 217,
            },
        });

        const result = await checkTosDR('https://www.google.com');
        expect(result.found).toBe(true);
        expect(result.grade).toBe('E');
        expect(result.score).toBe(20);
    });

    it('trusts the cached negative when the seed has no rating either', async () => {
        await chrome.storage.local.set({
            tosdr_cache: {
                'niche-site.com': {
                    data: { found: false, score: 0, source: 'fallback' },
                    timestamp: Date.now(),
                },
            },
        });

        const result = await checkTosDR('https://niche-site.com');
        expect(result.found).toBe(false);
        expect(result.source).toBe('fallback');
    });
});