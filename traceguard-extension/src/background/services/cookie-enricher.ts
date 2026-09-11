/**
 * =============================================================================
 * COOKIE ENRICHER, Identifies cookies and assigns metadata
 * =============================================================================
 */

import { CookieDetail } from '../../lib/types';
import { lookupCookie, lookupTrackerDomain } from './database-loader';
import { SetCookieRecord } from '../../lib/set-cookie';
import { logEvent } from '../../lib/diagnostics';

export async function enrichCookies(
    url: string,
    rawDomCookies: { name: string }[],
    networkSetCookies: SetCookieRecord[]
): Promise<CookieDetail[]> {
    const enriched: CookieDetail[] = [];
    const seenNames = new Set<string>();
    // A cookie classified by the Open Cookie Database and one classified by the
    // name-length heuristic look identical in the result, so keep them apart.
    const source = { database: 0, heuristic: 0 };

    const pageHost = new URL(url).hostname;
    
    // Helper to process a cookie
    const processCookie = async (name: string, domain: string, httpOnly: boolean, secure: boolean, sameSite: string, expirationDate: number | null, status: 'active' | 'blocked' = 'active') => {
        if (seenNames.has(name)) return;
        seenNames.add(name);
        
        // Lookup in Cookie Database
        const dbEntry = await lookupCookie(name);
        if (dbEntry) source.database += 1;
        else source.heuristic += 1;
        
        // Determine first/third party. Use explicit dot boundaries so a
        // lookalike domain ("notexample.com") is not treated as the same
        // party as "example.com".
        const isThirdParty = domain !== pageHost && !domain.endsWith('.' + pageHost) && !pageHost.endsWith('.' + domain);
        
        // Try to get organization from domain if DB doesn't have it
        let org = dbEntry?.dataController || null;
        if (!org && isThirdParty) {
            const radar = await lookupTrackerDomain(domain);
            if (radar?.owner) org = radar.owner;
        }
        
        // Determine category and invasiveness
        let category: CookieDetail['category'] = 'unclassified';
        let weight = 0;
        
        if (dbEntry) {
            category = dbEntry.category as CookieDetail['category'];
            if (category === 'marketing') weight = 3;
            else if (category === 'analytics') weight = 2;
            else if (category === 'functional') weight = 1;
        } else {
            // Heuristics
            if (isThirdParty) {
                category = 'unclassified';
                weight = 1;
                // Basic cross-site tracking heuristic
                if (name.length > 5 && !httpOnly) {
                    category = 'marketing';
                    weight = 2;
                }
            } else {
                category = 'necessary';
            }
        }
        
        enriched.push({
            name,
            domain,
            category,
            organization: org,
            platform: dbEntry?.platform || null,
            purpose: dbEntry?.description || null,
            retentionPeriod: dbEntry?.retentionPeriod || (expirationDate ? 'Persistent' : 'Session'),
            privacyUrl: dbEntry?.privacyUrl || null,
            httpOnly,
            secure,
            sameSite,
            expirationDate,
            isThirdParty,
            invasivenessWeight: weight,
            status
        });
    };
    
    // 1. Process Network Set-Cookies (most complete source: includes HttpOnly,
    //    Secure/SameSite flags, expiry, and third-party cookies, all from the
    //    Set-Cookie headers observed by the network monitor, no `cookies` perm).
    for (const c of networkSetCookies) {
        await processCookie(c.name, c.domain, c.httpOnly, c.secure, c.sameSite, c.expirationDate, 'active');
    }

    // 2. Process DOM cookies (first-party, non-HttpOnly fallback for cookies set
    //    via document.cookie, which never emit a Set-Cookie header).
    for (const c of rawDomCookies) {
        if (!seenNames.has(c.name)) {
            await processCookie(c.name, pageHost, false, false, 'unspecified', null, 'active');
        }
    }
    
    logEvent('enrich', 'debug', 'cookies_enriched', 'Cookies classified', {
        total: enriched.length,
        fromDatabase: source.database,
        fromHeuristic: source.heuristic,
        unclassified: enriched.filter(cookie => cookie.category === 'unclassified').length,
        thirdParty: enriched.filter(cookie => cookie.isThirdParty).length,
    });

    return enriched;
}
