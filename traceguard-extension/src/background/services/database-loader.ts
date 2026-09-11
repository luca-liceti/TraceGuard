/**
 * =============================================================================
 * DATABASE LOADER, Lazy-loads bundled privacy databases into memory
 * =============================================================================
 *
 * WHAT THIS FILE DOES:
 * Loads the 4 privacy databases that were bundled at build time into memory
 * for fast lookups during enrichment. Uses lazy loading so we only pay the
 * memory cost when the first analysis runs, not on extension startup.
 *
 * DATABASES:
 * - Tracker Radar: domain → { owner, category, prevalence, fingerprinting }
 * - Cookie DB: cookie name → { platform, category, description, retention }
 * - EasyPrivacy: Set of tracker domains
 * - Disconnect: domain → { category, entityName }
 * =============================================================================
 */

import { captureError, logEvent } from '../../lib/diagnostics';

/**
 * Records a successful database load, including its entry count.
 *
 * A database that loads empty is as broken as one that fails to load: an empty
 * EasyPrivacy set makes `isTrackerDomain` return false for every domain, so the
 * tracker table reports "0 trackers" on a page full of them, and an empty cookie
 * database pushes every cookie onto the heuristic path. Entry counts also catch
 * a database that loads with a handful of rows and silently under-detects.
 */
function recordDatabaseLoaded(name: string, entries: number): void {
    if (entries === 0) {
        captureError('enrich', new Error(`${name} database loaded with zero entries`), 'database_empty', { database: name });
        return;
    }
    logEvent('enrich', 'debug', 'database_loaded', `${name} loaded`, { database: name, entries });
}

/**
 * Records a database that could not be read. These are bundled assets, so a
 * failure here means the package is broken and detection is degraded; it used to
 * reach a console nobody had open.
 */
function recordDatabaseFailed(name: string, error: unknown): void {
    captureError('enrich', error, 'database_load_failed', { database: name });
}

interface TrackerRadarEntry {
    owner: string | null;
    displayName: string | null;
    category: string | null;
    prevalence: number;
    fingerprinting: number;
}

interface CookieDBEntry {
    platform: string | null;
    category: string;
    description: string | null;
    retentionPeriod: string | null;
    dataController: string | null;
    privacyUrl: string | null;
}

interface CookieDBWildcard {
    pattern: string;
    regex: string;
    entry: CookieDBEntry;
}

interface CookieDatabase {
    exact: Record<string, CookieDBEntry>;
    wildcards: CookieDBWildcard[];
}

interface DisconnectEntry {
    category: string;
    entityName: string;
}

// Cached databases (null = not loaded yet)
let _trackerRadar: Record<string, TrackerRadarEntry> | null = null;
let _cookieDB: CookieDatabase | null = null;
let _easyPrivacySet: Set<string> | null = null;
let _disconnectMap: Record<string, DisconnectEntry> | null = null;
let _tosdrMap: Record<string, any> | null = null;

// Compiled wildcard regexes (cached after first load)
let _compiledWildcards: Array<{ regex: RegExp; entry: CookieDBEntry }> | null = null;

/**
 * Load and cache the DuckDuckGo Tracker Radar database.
 */
export async function getTrackerRadar(): Promise<Record<string, TrackerRadarEntry>> {
    if (_trackerRadar) return _trackerRadar;
    try {

        const url = chrome.runtime.getURL('assets/tracker-radar.json');
        const response = await fetch(url);
        const data = await response.json();
        _trackerRadar = (data.default || data) as Record<string, TrackerRadarEntry>;
        recordDatabaseLoaded('tracker-radar', Object.keys(_trackerRadar).length);
    } catch (e) {
        recordDatabaseFailed('tracker-radar', e);
        _trackerRadar = {};
    }
    return _trackerRadar;
}

/**
 * Load and cache the Open Cookie Database.
 */
export async function getCookieDB(): Promise<CookieDatabase> {
    if (_cookieDB) return _cookieDB;
    try {

        const url = chrome.runtime.getURL('assets/cookie-database.json');
        const response = await fetch(url);
        const data = await response.json();
        _cookieDB = (data.default || data) as CookieDatabase;
        // Pre-compile wildcard regexes
        _compiledWildcards = (_cookieDB.wildcards || []).map(w => ({
            regex: new RegExp(w.regex, 'i'),
            entry: w.entry,
        }));
        recordDatabaseLoaded('cookie-db', Object.keys(_cookieDB.exact).length + _cookieDB.wildcards.length);
    } catch (e) {
        recordDatabaseFailed('cookie-db', e);
        _cookieDB = { exact: {}, wildcards: [] };
        _compiledWildcards = [];
    }
    return _cookieDB;
}

/**
 * Load and cache the EasyPrivacy domain set.
 */
export async function getEasyPrivacySet(): Promise<Set<string>> {
    if (_easyPrivacySet) return _easyPrivacySet;
    try {

        const url = chrome.runtime.getURL('assets/easyprivacy-domains.json');
        const response = await fetch(url);
        const data = await response.json();
        const arr = (data.default || data) as string[];
        _easyPrivacySet = new Set(arr);
        recordDatabaseLoaded('easyprivacy', _easyPrivacySet.size);
    } catch (e) {
        recordDatabaseFailed('easyprivacy', e);
        _easyPrivacySet = new Set();
    }
    return _easyPrivacySet;
}

/**
 * Load and cache the Disconnect services map.
 */
export async function getDisconnectMap(): Promise<Record<string, DisconnectEntry>> {
    if (_disconnectMap) return _disconnectMap;
    try {

        const url = chrome.runtime.getURL('assets/disconnect-services.json');
        const response = await fetch(url);
        const data = await response.json();
        _disconnectMap = (data.default || data) as Record<string, DisconnectEntry>;
        recordDatabaseLoaded('disconnect', Object.keys(_disconnectMap).length);
    } catch (e) {
        recordDatabaseFailed('disconnect', e);
        _disconnectMap = {};
    }
    return _disconnectMap;
}

/**
 * Load and cache the ToS;DR database.
 */
export async function getTosDRMap(): Promise<Record<string, any>> {
    if (_tosdrMap) return _tosdrMap;
    try {

        const url = chrome.runtime.getURL('assets/tosdr-data.json');
        const response = await fetch(url);
        const data = await response.json();
        _tosdrMap = (data.default || data) as Record<string, any>;
        recordDatabaseLoaded('tosdr', Object.keys(_tosdrMap).length);
    } catch (e) {
        recordDatabaseFailed('tosdr', e);
        _tosdrMap = {};
    }
    return _tosdrMap;
}

/**
 * Looks up a cookie name in the Open Cookie Database.
 * Checks exact match first, then wildcard patterns.
 * Returns null if not found.
 */
export async function lookupCookie(cookieName: string): Promise<CookieDBEntry | null> {
    const db = await getCookieDB();
    const lowerName = cookieName.toLowerCase();

    // 1. Exact match
    if (db.exact[lowerName]) return db.exact[lowerName];

    // 2. Wildcard match (pre-compiled regexes)
    if (_compiledWildcards) {
        for (const { regex, entry } of _compiledWildcards) {
            if (regex.test(cookieName)) return entry;
        }
    }

    return null;
}

/**
 * Looks up a domain in the Tracker Radar database.
 * Tries exact match, then parent domain (e.g., sub.tracker.com → tracker.com).
 */
export async function lookupTrackerDomain(domain: string): Promise<TrackerRadarEntry | null> {
    const radar = await getTrackerRadar();
    const lower = domain.toLowerCase();

    // 1. Exact match
    if (radar[lower]) return radar[lower];

    // 2. Try parent domain (strip one subdomain level)
    const parts = lower.split('.');
    if (parts.length > 2) {
        const parent = parts.slice(1).join('.');
        if (radar[parent]) return radar[parent];
    }

    // 3. Try two levels up
    if (parts.length > 3) {
        const grandParent = parts.slice(2).join('.');
        if (radar[grandParent]) return radar[grandParent];
    }

    return null;
}

/**
 * Generic content-delivery / cloud-hosting domains. Blocklists like EasyPrivacy
 * flag them because SOME trackers ride on them, but countless legitimate sites
 * serve assets from CloudFront or S3 - counting them as trackers drags the WSS
 * down and can turn an otherwise-safe site into a "risky" one that gets PII
 * penalties. They are never trackers themselves.
 */
const GENERIC_CDN_DOMAINS: readonly string[] = ['cloudfront.net', 'amazonaws.com'];

/**
 * Checks if a domain is in any of the privacy blocklists.
 */
export async function isTrackerDomain(domain: string): Promise<boolean> {
    const lower = domain.toLowerCase();

    // Generic CDN / cloud hosts (and any of their subdomains) are never trackers.
    if (GENERIC_CDN_DOMAINS.some(d => lower === d || lower.endsWith('.' + d))) {
        return false;
    }

    const [radar, easyprivacy, disconnect] = await Promise.all([
        getTrackerRadar(),
        getEasyPrivacySet(),
        getDisconnectMap(),
    ]);

    if (radar[lower]) return true;
    if (easyprivacy.has(lower)) return true;
    if (disconnect[lower]) return true;

    // Check parent domain
    const parts = lower.split('.');
    if (parts.length > 2) {
        const parent = parts.slice(1).join('.');
        if (radar[parent] || easyprivacy.has(parent) || disconnect[parent]) return true;
    }

    return false;
}

/**
 * Gets the Disconnect entity (owner company) for a domain.
 * Falls back to the parent domain like getDisconnectCategory does.
 */
export async function getDisconnectEntity(domain: string): Promise<string | null> {
    const map = await getDisconnectMap();
    const lower = domain.toLowerCase();

    const entry = map[lower] || (domain.split('.').length > 2 ? map[domain.split('.').slice(1).join('.').toLowerCase()] : null);
    return entry?.entityName || null;
}

/**
 * Gets the Disconnect category for a domain.
 * Maps Disconnect category names to our internal category strings.
 */
export async function getDisconnectCategory(domain: string): Promise<string | null> {
    const map = await getDisconnectMap();
    const lower = domain.toLowerCase();

    const entry = map[lower] || (domain.split('.').length > 2 ? map[domain.split('.').slice(1).join('.').toLowerCase()] : null);
    if (!entry) return null;

    const CAT_MAP: Record<string, string> = {
        'Advertising': 'advertising',
        'Analytics': 'analytics',
        'Social': 'social',
        'Content': 'content',
        'Cryptomining': 'cryptomining',
        'Fingerprinting': 'fingerprinting',
        'FingerprintingInvasive': 'fingerprinting',
    };
    return CAT_MAP[entry.category] || entry.category.toLowerCase();
}

/**
 * Pre-warms all databases by loading them all at once.
 * Call this during extension startup to avoid cold-load delay on first analysis.
 */
export async function preWarmDatabases(): Promise<void> {
    await Promise.all([
        getTrackerRadar(),
        getCookieDB(),
        getEasyPrivacySet(),
        getDisconnectMap(),
    ]);
    console.log('[DatabaseLoader] All databases pre-warmed and ready');
}
