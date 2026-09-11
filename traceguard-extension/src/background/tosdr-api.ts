/**
 * =============================================================================
 * ToS;DR API INTEGRATION - Privacy Policy Ratings
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This file integrates with ToS;DR (Terms of Service; Didn't Read) - a community
 * project that reads privacy policies so you don't have to! They grade policies
 * from A (best) to E (worst), like school grades.
 * 
 * WHAT IS ToS;DR?
 * ToS;DR (tosdr.org) is a volunteer project where people read the long, boring
 * legal documents (Terms of Service, Privacy Policies) for popular websites
 * and summarize the good, bad, and ugly parts. Then they give each site a grade.
 * 
 * HOW WE USE IT:
 * 1. When you visit a website, we send the domain to ToS;DR's API
 * 2. They tell us if they have a rating for that site
 * 3. We convert their grade (A-E) to a score (100, 80, 60, 40, 20)
 * 4. That score contributes to the Website Safety Score (WSS)
 * 
 * SCORING CONVERSION:
 * - Grade A = 100 (Excellent - respects your privacy)
 * - Grade B = 80 (Good - mostly fair terms)
 * - Grade C = 60 (Fair - some concerns)
 * - Grade D = 40 (Poor - problematic terms)
 * - Grade E = 20 (Bad - serious privacy issues)
 * - No rating = 0 (Unknown - can't evaluate)
 * 
 * CACHING:
 * Results are cached for 5 minutes to avoid hammering the API.
 * The cache is stored in memory and clears when the extension reloads.
 * 
 * API INFO:
 * - URL: https://api.tosdr.org/search/v4/
 * - No API key required (free and open)
 * - Documentation: https://tosdr.org/api
 * =============================================================================
 */

interface TosDRResult {
    found: boolean;
    grade?: string; // A-E
    score: number; // 0-100 (0 = dangerous/no rating, 100 = safe/A-grade)
    source: 'tosdr' | 'fallback';
    serviceName?: string;
    serviceId?: number;
    points?: { title: string; classification: string }[];
    documents?: { name: string; url: string }[];
}

// Cache for ToS;DR results is no longer needed (100% local)

/**
 * Extract the main/root domain from URL
 * Examples:
 * - www.google.com -> google.com
 * - antigravity.google.com -> google.com
 * - antigravity.google -> google (new-style brand TLD)
 * - example.co.uk -> example.co.uk
 */
function extractMainDomain(url: string): string {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        // Split hostname into parts
        const parts = hostname.split('.');

        // Handle new-style brand TLDs (company owns the TLD itself)
        // For domains like antigravity.google, search ToS;DR for "google"
        // Brand TLDs only (single-owner). 'app', 'dev' and 'page' are public
        // registrable TLDs, so collapsing vercel.app -> "app" was wrong.
        const brandTLDs = ['google', 'microsoft', 'apple', 'amazon', 'facebook', 'meta'];
        if (parts.length === 2 && brandTLDs.includes(parts[1])) {
            return parts[1]; // Return just "google" for antigravity.google
        }

        // Handle common multi-part TLDs (co.uk, com.au, etc.)
        const multiPartTLDs = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'org.uk'];
        for (const tld of multiPartTLDs) {
            if (hostname.endsWith('.' + tld)) {
                return parts.slice(-3).join('.');
            }
        }

        // Standard case: return last 2 parts (domain + TLD)
        if (parts.length >= 2) {
            return parts.slice(-2).join('.');
        }

        return hostname;
    } catch {
        return url;
    }
}


/**
 * Convert ToS;DR grade to risk score (standard: 0 = dangerous, 100 = safe)
 * A = 100 (excellent), B = 80 (good), C = 60 (fair), D = 40 (poor), E = 20 (bad), None = 0 (no rating = dangerous)
 */
function gradeToScore(grade: string | undefined): number {
    if (!grade) return 0;

    const gradeMap: Record<string, number> = {
        'A': 100,
        'B': 80,
        'C': 60,
        'D': 40,
        'E': 20
    };

    return gradeMap[grade.toUpperCase()] ?? 0;
}

import { getTosDRMap } from './services/database-loader';
import { captureError, logEvent } from '../lib/diagnostics';
import { storage } from '../lib/storage';
import { rateLimiters } from '../lib/rate-limiter';
import { fetchWithTimeout } from '../lib/utils';

interface CacheEntry {
    data: TosDRResult;
    timestamp: number;
}

let inMemoryCache: Record<string, CacheEntry> | null = null;

// One-time opt-in prompt for the (default-off) cloud lookup.
let cloudPromptScheduled = false;
async function maybePromptCloudOptIn() {
    if (cloudPromptScheduled) return;
    const { cloudTosdrPrompted } = await chrome.storage.local.get('cloudTosdrPrompted');
    if (cloudTosdrPrompted) {
        cloudPromptScheduled = true;
        return;
    }
    const key = await storage.getVaultKey();
    const id = await storage.addNotification({
        type: 'info',
        title: 'Live rating updates are off',
        message: 'Turn it on to fetch the latest ratings from tosdr.org when our local data is stale. Sends the current site\'s domain to tosdr.org.',
        severity: 'info',
        actionUrl: '/overview?openSettings=privacy'
    }, key);
    if (id) {
        cloudPromptScheduled = true;
        await chrome.storage.local.set({ cloudTosdrPrompted: true });
    }
}

async function getCache(): Promise<Record<string, CacheEntry>> {
    if (inMemoryCache) return inMemoryCache;
    const result = await chrome.storage.local.get<Record<string, any>>('tosdr_cache');
    inMemoryCache = result.tosdr_cache || {};
    return inMemoryCache!;
}

async function saveCache(domain: string, entry: CacheEntry) {
    if (!inMemoryCache) inMemoryCache = {};
    inMemoryCache[domain] = entry;
    await chrome.storage.local.set({ tosdr_cache: inMemoryCache });
}

async function fetchFromTosdr(domain: string): Promise<TosDRResult | null> {
    try {
        return await rateLimiters.tosdr.execute(async () => {
            const searchRes = await fetchWithTimeout(`https://api.tosdr.org/search/v4/?query=${encodeURIComponent(domain)}`);
            if (!searchRes.ok) return null;
            const searchData = await searchRes.json();
            
            if (searchData?.parameters?.services?.[0]) {
                const service = searchData.parameters.services[0];
                const detailsRes = await fetchWithTimeout(`https://api.tosdr.org/service/v2/?id=${service.id}`);
                if (!detailsRes.ok) return null;
                const detailsData = await detailsRes.json();
                const details = detailsData?.parameters;
                
                if (details) {
                    return {
                        found: true,
                        grade: service.rating && service.rating !== 'N/A' ? service.rating : undefined,
                        score: gradeToScore(service.rating),
                        source: 'tosdr',
                        serviceName: service.name,
                        serviceId: service.id,
                        points: details.points?.map((p: any) => ({ title: p.title, classification: p.case?.classification || p.classification || 'neutral' })) || [],
                        documents: details.documents?.map((d: any) => ({ name: d.name, url: d.url })) || []
                    };
                }
            }
            return null;
        });
    } catch (err) {
        captureError('enrich', err, 'tosdr_fetch_failed', { host: domain });
    }
    return null;
}

/**
 * Check ToS;DR rating using a Hybrid approach (Stale-While-Revalidate).
 */
export async function checkTosDR(url: string): Promise<TosDRResult> {
    const domain = extractMainDomain(url);
    const settings = await storage.getSettings();
    const enableCloud = settings.enableCloudTosdr ?? false;
    if (!enableCloud) await maybePromptCloudOptIn();
    const refreshDays = settings.databaseRefreshDays || 7;
    const refreshMs = refreshDays * 24 * 60 * 60 * 1000;
    
    // Helper to trigger background update
    const triggerLazyUpdate = async () => {
        if (!enableCloud) return;
        const fresh = await fetchFromTosdr(domain);
        if (fresh) {
            await saveCache(domain, { data: fresh, timestamp: Date.now() });
        } else {
            // Cache a negative result to avoid spamming the API
            await saveCache(domain, { data: { found: false, score: 0, source: 'fallback' }, timestamp: Date.now() });
        }
    };

    // Negatives (failed lookups) expire far sooner than real ratings, so a
    // transient cloud outage gets retried within a day instead of a week.
    const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

    // 1. Check dynamic cache first
    const cache = await getCache();
    const cachedEntry = Object.prototype.hasOwnProperty.call(cache, domain) ? cache[domain] : undefined;
    
    if (cachedEntry) {
        const isNegative = cachedEntry.data?.found === false;
        const ttlMs = isNegative ? NEGATIVE_TTL_MS : refreshMs;
        const isStale = (Date.now() - cachedEntry.timestamp) > ttlMs;
        if (isStale) {
            logEvent('enrich', 'debug', 'tosdr_cache_stale', 'Cached rating is stale, refreshing', { host: domain, negative: isNegative });
            triggerLazyUpdate(); // fire and forget
        } else {
            logEvent('enrich', 'debug', 'tosdr_cache_hit', 'Cached rating used', { host: domain, score: cachedEntry.data?.score });
        }

        // A negative (found:false) result must never shadow a bundled seed
        // rating: a transient cloud failure would otherwise hide known-good
        // local data for up to refreshDays. Check the seed first; only trust
        // the cached "not found" when the seed agrees it has no rating.
        if (isNegative) {
            const seedMap = await getTosDRMap();
            const seedResult = Object.prototype.hasOwnProperty.call(seedMap, domain) ? seedMap[domain] : undefined;
            if (seedResult) {
                logEvent('enrich', 'debug', 'tosdr_seed_overrode_negative', 'Bundled seed rating overrode a cached miss', { host: domain });
                return seedResult as TosDRResult;
            }
        }

        return cachedEntry.data;
    }
    
    // 2. Check local seed database
    const seedMap = await getTosDRMap();
    const seedResult = Object.prototype.hasOwnProperty.call(seedMap, domain) ? seedMap[domain] : undefined;
    
    if (seedResult) {
        const seedTimestamp = seedResult.lastUpdated || 0;
        const isStale = seedTimestamp > 0 && (Date.now() - seedTimestamp) > refreshMs;
        
        // If missing timestamp or explicitly stale, trigger an update
        if (isStale || seedTimestamp === 0) {
            logEvent('enrich', 'debug', 'tosdr_seed_stale', 'Bundled seed rating is stale, refreshing', { host: domain, lastUpdated: seedTimestamp });
            triggerLazyUpdate();
        } else {
            logEvent('enrich', 'debug', 'tosdr_seed_used', 'Bundled seed rating used', { host: domain, score: seedResult.score, grade: seedResult.grade });
        }
        
        return seedResult as TosDRResult;
    }
    
    // 3. Not in seed, not in cache
    if (enableCloud) {
        logEvent('enrich', 'debug', 'tosdr_dynamic_fetch', 'No local rating, fetching from ToS;DR', { host: domain });
        const fresh = await fetchFromTosdr(domain);
        if (fresh) {
            await saveCache(domain, { data: fresh, timestamp: Date.now() });
            return fresh;
        }
        
        // Cache failure
        const fallback: TosDRResult = { found: false, score: 0, source: 'fallback' };
        await saveCache(domain, { data: fallback, timestamp: Date.now() });
        return fallback;
    }
    
    logEvent('enrich', 'debug', 'tosdr_no_rating_cloud_disabled', 'No local rating and cloud lookup is disabled', { host: domain });
    return { found: false, score: 0, source: 'fallback' };
}

/**
 * Clear ToS;DR dynamic cache
 */
export async function clearTosDRCache(): Promise<void> {
    inMemoryCache = {};
    await chrome.storage.local.remove('tosdr_cache');
    logEvent('enrich', 'debug', 'tosdr_cache_cleared', 'Dynamic ToS;DR cache cleared');
}
