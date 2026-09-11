/**
 * =============================================================================
 * REPUTATION SERVICE - Checking if Websites are Dangerous
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This file handles checking if a website is known to be dangerous. Think of it
 * like a security guard checking names against a "do not enter" list.
 * 
 * HOW IT WORKS:
 * The reputation check happens in layers (like multiple security checkpoints):
 * 
 * Layer 1: User Whitelist - Sites you personally trust (always safe = 100)
 * Layer 2: User Blacklist - Sites you personally blocked (always dangerous = 0)
 * Layer 3: Static Blacklist - A built-in list of known bad sites (dangerous = 0)
 * Layer 4: Default - If nothing bad found, the site is considered safe (= 100)
 * 
 * SCORING:
 * - 100 = Safe (passed all checks)
 * - 0 = Dangerous (found on a blacklist or in malware database)
 * 
 * KEY TERMS:
 * - Blacklist: A list of known dangerous websites to avoid
 * - Whitelist: A list of websites you trust (overrides other checks)
 * This is deliberately local-only: URLhaus now requires a per-user Auth-Key,
 * which must not be embedded in a consumer extension.
 * =============================================================================
 */

import { refreshThreatFeed } from './threat-feed';
import { captureError, logEvent } from '../../lib/diagnostics';

// =============================================================================
// TYPE DEFINITIONS
// These define the "shape" of data we work with (like a blueprint)
// =============================================================================

/**
 * Represents the structure of our blacklist file.
 * The blacklist is a list of known dangerous domains loaded from a JSON file.
 */
interface Blacklist {
    version: string;      // Version number of the blacklist (e.g., "1.0.0")
    updated: string;      // When the blacklist was last updated
    domains: string[];    // Array of dangerous domain names
}

// =============================================================================
// MODULE STATE
// Variables that persist across function calls (like the extension's memory)
// =============================================================================

// This Set stores all domains from our built-in blacklist
// A Set is like an array but automatically prevents duplicates and is faster to search
let staticBlacklist: Set<string> = new Set();


// =============================================================================
// BLACKLIST LOADING
// Loads the list of known dangerous sites from our bundled file
// =============================================================================

/**
 * Loads the static blacklist from the extension's assets folder.
 * 
 * This function reads a JSON file that comes bundled with the extension,
 * containing a list of known dangerous domain names. This list is like
 * a "do not visit" list that we check every website against.
 * 
 * This is called when:
 * - The extension is first installed
 * - The browser starts up
 */
export async function loadBlacklist() {
    try {
        // Load the phishing/malware domain feed (built from OpenPhish + phishunt).
        const url = chrome.runtime.getURL('assets/phishlist.json');

        // Fetch and parse the JSON file
        const response = await fetch(url);
        const data: Blacklist = await response.json();

        // Store domains in a Set for fast lookup
        // (Checking if something is in a Set is much faster than searching an array)
        staticBlacklist = new Set(data.domains);

        logEvent('enrich', 'debug', 'blacklist_loaded', 'Threat blocklist loaded', {
            domains: staticBlacklist.size,
        });
    } catch (error) {
        // An unloaded blacklist means every domain scores 100, "not on any known
        // threat list", so this failure must never stay quiet.
        captureError('enrich', error, 'blacklist_load_failed');
    }
}

export interface ReputationResult {
    score: number;
    checks: string[];
}

/**
 * Refresh the static blacklist from the signed remote threat feed.
 * Keeps the bundled snapshot on any failure (offline, stale, forged, replay).
 */
export async function refreshBlacklistFromRemote(): Promise<boolean> {
    const domains = await refreshThreatFeed();
    if (domains && domains.length > 0) {
        staticBlacklist = new Set(domains);
        logEvent('enrich', 'debug', 'blacklist_refreshed', 'Threat blocklist refreshed', {
            domains: staticBlacklist.size,
        });
        return true;
    }
    return false;
}

/**
 * Check domain reputation with multi-layer system
 * 
 * Layer Priority:
 * 1. User Whitelist - Force safe (100)
 * 2. User Blacklist - Force critical (0)
 * 3. Static Blacklist - Known bad domains (0)
 * 4. Default - Safe (100)
 * 
 * @param url - The URL to check
 * @returns Reputation score (0 = high risk, 100 = safe) and checks
 */
export async function checkReputation(url: string): Promise<ReputationResult> {
    try {
        const domain = new URL(url).hostname;

        // One event per check, naming the layer that decided the score and the
        // size of the loaded blacklist. A blacklistSize of 0 means reputation
        // checks are effectively off and every site reads as clean, which is
        // impossible to tell from the score alone.
        const decide = (layer: string, score: number, checks: string[]) => {
            logEvent('enrich', 'debug', 'reputation_checked', `${domain} scored ${score} in layer ${layer}`, {
                host: domain,
                layer,
                score,
                blacklistSize: staticBlacklist.size,
            });
            return { score, checks };
        };

        // Get user's custom whitelist and blacklist from storage
        const result = await chrome.storage.local.get('settings');
        const settings = (result.settings || {}) as { whitelist?: string[]; blacklist?: string[] };
        const userWhitelist: string[] = settings.whitelist || [];
        const userBlacklist: string[] = settings.blacklist || [];

        const domainMatches = (dom: string, pattern: string) => dom === pattern || dom.endsWith('.' + pattern);

        // LAYER 1: Whitelist takes absolute priority (force safe)
        if (userWhitelist.some(w => domainMatches(domain, w))) {
            return decide('user-whitelist', 100, ['Whitelisted by user']);
        }

        // LAYER 2: User blacklist (force critical)
        if (userBlacklist.some(b => domainMatches(domain, b))) {
            return decide('user-blacklist', 0, ['Found in user blacklist']);
        }

        // LAYER 3: Static blacklist (known malicious domains)
        if (staticBlacklist.has(domain)) {
            return decide('static-blacklist', 0, ['Found in static blacklist of known malicious domains']);
        }

        // LAYER 4: Default - safe
        return decide('default', 100, []);

    } catch (error) {
        captureError('enrich', error, 'reputation_check_failed');
        return { score: 50, checks: ['Reputation check failed — score uncertain'] }; // Default to neutral if invalid URL
    }
}

/**
 * Synchronous version for backward compatibility
 * Note: This should be phased out in favor of the async version
 * Mirrors the local-only async reputation check.
 */
export function checkReputationSync(url: string): ReputationResult {
    try {
        const domain = new URL(url).hostname;
        if (staticBlacklist.has(domain)) {
            return { score: 0, checks: ['Found in static blacklist of known malicious domains'] };
        }
        return { score: 100, checks: [] };
    } catch (error) {
        captureError('enrich', error, 'reputation_check_failed', { mode: 'sync' });
        return { score: 50, checks: ['Reputation check failed — score uncertain'] };
    }
}
