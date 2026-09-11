/**
 * =============================================================================
 * COOKIE DETECTOR - Analyzing Tracking Cookies
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This detector analyzes cookies on the webpage to find tracking and
 * third-party cookies. Cookies are like little sticky notes that websites
 * leave in your browser to remember things about you.
 * 
 * WHAT ARE COOKIES?
 * Cookies are small pieces of data stored in your browser. They can be:
 * - First-party: Set by the website you're visiting (usually harmless)
 * - Third-party: Set by other companies to track you across sites (privacy risk)
 * 
 * COOKIE CATEGORIES (by invasiveness):
 * 
 * 3× CROSS-SITE TRACKERS (Most invasive):
 *    These follow you across multiple websites to build a profile
 *    Examples: DoubleClick (IDE), Facebook Pixel (_fbp), LinkedIn (bcookie)
 * 
 * 2× ANALYTICS (Moderately invasive):
 *    These track your behavior on individual sites
 *    Examples: Google Analytics (_ga, _gid), Hotjar (_hjid), Mixpanel (mp_)
 * 
 * 1× OTHER THIRD-PARTY (Less invasive but still tracking):
 *    Examples: Google preferences (NID, PREF, CONSENT)
 * 
 * 0× FIRST-PARTY (Safe):
 *    These are usually session or authentication cookies from the site itself
 * 
 * SCORING FORMULA:
 * Uses logarithmic calculation: 100 - 12 × log₂(weighted_score + 1)
 * 
 * EXAMPLES:
 * - 0 tracking cookies → Score: 100 (safe)
 * - 2 analytics cookies (4 weighted) → Score: ~72
 * - 2 cross-site trackers (6 weighted) → Score: ~66
 * * TECHNICAL NOTE:
 * document.cookie only shows cookies accessible to JavaScript (not HttpOnly).
 * Full cookie attributes (HttpOnly, Secure, SameSite, expiry, third-party
 * domain) are captured by the background network monitor from `Set-Cookie`
 * response headers, no `cookies` permission is required.
 * =============================================================================
 */

import { captureError, logEvent } from '../../lib/diagnostics';

/**
 * Represents information about a single cookie.
 *
 * NOTE: values are deliberately never captured or used. `document.cookie` only
 * exposes name=value pairs, so the value substring is discarded immediately;
 * only the name is kept for categorization.
 */
interface CookieInfo {
    name: string;                 // The cookie's name
    category: 'cross-site-tracker' | 'analytics' | 'third-party' | 'first-party';
    invasivenessWeight: number;   // 3x, 2x, 1x, or 0 depending on category
}

/**
 * Cookie invasiveness categories and their weights
 */
const COOKIE_CATEGORIES = {
    // Cross-site trackers (3x weight) - Most invasive
    CROSS_SITE_TRACKERS: {
        weight: 3,
        patterns: [
            'IDE',          // DoubleClick
            'test_cookie',  // DoubleClick
            'DSID',         // DoubleClick
            '__gads',       // Google Ads
            '__gac',        // Google Ads Conversion
            '_fbp',         // Facebook Pixel
            '_fbc',         // Facebook Conversion
            'fr',           // Facebook
            '__qca',        // Quantcast
            '_pinterest',   // Pinterest
            'MUID',         // Microsoft/Bing
            'ANON',         // Microsoft
            'YSC',          // YouTube
            'VISITOR_INFO', // YouTube
            'GPS',          // YouTube
            '__stripe',     // Stripe tracking
            'intercom',     // Intercom tracking
            '_mkto',        // Marketo
            'bcookie',      // LinkedIn
            'lidc',         // LinkedIn
            'UserMatchHistory', // LinkedIn
        ]
    },
    // Analytics cookies (2x weight) - Moderately invasive
    ANALYTICS: {
        weight: 2,
        patterns: [
            '_ga',          // Google Analytics
            '_gid',         // Google Analytics
            '_gat',         // Google Analytics
            '__utm',        // Google Analytics (legacy)
            'ajs_',         // Segment
            'mp_',          // Mixpanel
            '_hjid',        // Hotjar
            '_dc_gtm',      // Google Tag Manager
            'optimizelyEndUserId', // Optimizely
            '_vwo',         // VWO
            '_clck',        // Clarity
            '_clsk',        // Clarity
        ]
    },
    // Other third-party (1x weight) - Less invasive but still tracking
    OTHER_THIRD_PARTY: {
        weight: 1,
        patterns: [
            'NID',          // Google
            'PREF',         // Google
            '1P_JAR',       // Google
            'CONSENT',      // Google
            'ANID',         // Google
            'APISID',       // Google
            'HSID',         // Google
            'SAPISID',      // Google
            'SID',          // Google
            'SIDCC',        // Google
            'SSID',         // Google
        ]
    }
};

/**
 * Parse document.cookie string into individual cookies with categorization
 */
function parseCookies(): CookieInfo[] {
    const cookieString = document.cookie;
    if (!cookieString || cookieString.trim() === '') {
        return [];
    }

    const cookies: CookieInfo[] = [];

    // Split by semicolon to get individual cookies
    const cookiePairs = cookieString.split(';');

    for (const pair of cookiePairs) {
        const trimmedPair = pair.trim();
        if (!trimmedPair) continue;

        const equalIndex = trimmedPair.indexOf('=');
        if (equalIndex === -1) continue;

        const name = trimmedPair.substring(0, equalIndex).trim();

        // Categorize cookie and get invasiveness weight (value is discarded)
        const { category, weight } = categorizeCookie(name);

        cookies.push({
            name,
            category,
            invasivenessWeight: weight
        });
    }

    return cookies;
}

/**
 * Matches a cookie name against a known tracker-cookie pattern without false
 * positives from substring matches. Most of these cookies are exact names
 * (Facebook's "fr", DoubleClick's "IDE", Google's "SID"); the rest are
 * prefixes with a separator ("_ga_<id>", "intercom-session-<id>"). A plain
 * substring check would flag innocent first-party names - "sessionid"
 * contains "sid", "refresh" contains "fr" - as trackers, dragging the WSS
 * down and turning safe sites into "risky" ones that get penalized.
 */
function cookieNameMatches(name: string, pattern: string): boolean {
    const n = name.toLowerCase();
    const p = pattern.toLowerCase();
    if (n === p) return true;
    if (!n.startsWith(p)) return false;
    const next = n[p.length];
    // Prefix must continue with a separator, e.g. "_ga_ABC" or "intercom-xyz".
    return next !== undefined && /[_-]/.test(next);
}

/**
 * Categorize cookie by invasiveness level
 * Returns category and weight multiplier
 */
function categorizeCookie(name: string): { category: CookieInfo['category']; weight: number } {
    const lowerName = name.toLowerCase();

    // Check cross-site trackers (most invasive)
    for (const pattern of COOKIE_CATEGORIES.CROSS_SITE_TRACKERS.patterns) {
        if (cookieNameMatches(lowerName, pattern)) {
            return { category: 'cross-site-tracker', weight: COOKIE_CATEGORIES.CROSS_SITE_TRACKERS.weight };
        }
    }

    // Check analytics cookies (moderately invasive)
    for (const pattern of COOKIE_CATEGORIES.ANALYTICS.patterns) {
        if (cookieNameMatches(lowerName, pattern)) {
            return { category: 'analytics', weight: COOKIE_CATEGORIES.ANALYTICS.weight };
        }
    }

    // Check other third-party cookies
    for (const pattern of COOKIE_CATEGORIES.OTHER_THIRD_PARTY.patterns) {
        if (cookieNameMatches(lowerName, pattern)) {
            return { category: 'third-party', weight: COOKIE_CATEGORIES.OTHER_THIRD_PARTY.weight };
        }
    }

    // Additional heuristics for unknown cookies
    if (isLikelyThirdPartyCookie(name)) {
        return { category: 'third-party', weight: 1 };
    }

    // First-party cookie (not tracking)
    return { category: 'first-party', weight: 0 };
}

/**
 * Heuristic to detect likely third-party tracking cookies (fallback)
 * Based on common naming patterns and known tracking cookie prefixes.
 * Values are intentionally not inspected.
 */
function isLikelyThirdPartyCookie(name: string): boolean {
    const lowerName = name.toLowerCase();

    // Common third-party tracking cookie patterns
    const trackingPatterns = [
        '_ga',      // Google Analytics
        '_gid',     // Google Analytics
        '_gat',     // Google Analytics
        '__utm',    // Google Analytics (legacy)
        '_fbp',     // Facebook Pixel
        '_fbc',     // Facebook Conversion
        'fr',       // Facebook
        '__qca',    // Quantcast
        '_pinterest', // Pinterest
        'IDE',      // DoubleClick
        'test_cookie', // DoubleClick
        'DSID',     // DoubleClick
        'NID',      // Google
        'PREF',     // Google
        '1P_JAR',   // Google
        'CONSENT',  // Google
        'ANID',     // Google
        'APISID',   // Google
        'HSID',     // Google
        'SAPISID',  // Google
        'SID',      // Google
        'SIDCC',    // Google
        'SSID',     // Google
        '__stripe', // Stripe
        'optimizelyEndUserId', // Optimizely
        'ajs_',     // Segment
        'mp_',      // Mixpanel
        '_hjid',    // Hotjar
        '_dc_gtm',  // Google Tag Manager
        'intercom', // Intercom
        '_mkto',    // Marketo
    ];

    // Check if cookie name matches known tracking patterns
    for (const pattern of trackingPatterns) {
        if (cookieNameMatches(lowerName, pattern)) {
            return true;
        }
    }

    // Additional heuristics:
    // - Cookie names with underscores/dashes often indicate third-party

    // Check for common tracking cookie naming conventions
    if (lowerName.startsWith('_') || lowerName.startsWith('__')) {
        // Many tracking cookies start with underscores
        // But exclude common first-party session cookies
        const firstPartyPatterns = ['session', 'csrf', 'xsrf', 'auth', 'token'];
        const isFirstParty = firstPartyPatterns.some(pattern => lowerName.includes(pattern));
        if (!isFirstParty) {
            return true;
        }
    }

    return false;
}

/**
 * Detailed cookie detection for sidepanel display
 */
export function detectCookiesDetailed(): {
    score: number;
    total: number;
    tracking: number;
    thirdParty: number;
    details?: Record<string, number>;
} {
    try {
        const cookies = parseCookies();

        let totalWeightedScore = 0;
        let crossSiteCount = 0;
        let analyticsCount = 0;
        let thirdPartyCount = 0;

        for (const cookie of cookies) {
            if (cookie.category !== 'first-party') {
                totalWeightedScore += cookie.invasivenessWeight;
                if (cookie.category === 'cross-site-tracker') crossSiteCount++;
                else if (cookie.category === 'analytics') analyticsCount++;
                else if (cookie.category === 'third-party') thirdPartyCount++;
            }
        }

        const K = 12;
        const score = totalWeightedScore === 0
            ? 100
            : Math.max(0, Math.round(100 - (K * Math.log2(totalWeightedScore + 1))));

        return {
            score,
            total: cookies.length,
            tracking: crossSiteCount + analyticsCount,
            thirdParty: thirdPartyCount,
            details: {
                'cross-site-tracker': crossSiteCount,
                'analytics': analyticsCount,
                'third-party': thirdPartyCount,
            }
        };
    } catch (error) {
        // A throw here used to be indistinguishable from a clean page: the
        // caller received a perfect 100 with zero cookies. Record the failure so
        // the two can be told apart in the diagnostics bundle.
        captureError('detector', error, 'cookie_detector_failed');
        return { score: 100, total: 0, tracking: 0, thirdParty: 0 };
    }
}

/**
 * Returns raw cookie names for background enrichment (values are intentionally
 * not read or persisted).
 */
export function detectCookiesRaw(): { name: string }[] {
    try {
        const cookieString = document.cookie;
        if (!cookieString || cookieString.trim() === '') {
            return [];
        }
        
        return cookieString.split(';').map(pair => {
            const trimmedPair = pair.trim();
            const equalIndex = trimmedPair.indexOf('=');
            const name = (equalIndex === -1 ? trimmedPair : trimmedPair.substring(0, equalIndex)).trim();
            return name ? { name } : null;
        }).filter(Boolean) as { name: string }[];
    } catch (e) {
        logEvent('detector', 'warn', 'cookie_parse_failed', 'Could not parse document.cookie', { error: String(e) });
        return [];
    }
}
