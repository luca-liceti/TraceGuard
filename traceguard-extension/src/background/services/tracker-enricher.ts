/**
 * =============================================================================
 * TRACKER ENRICHER, Identifies trackers and assigns metadata
 * =============================================================================
 */

import { TrackerDetail, NetworkRequestDetail } from '../../lib/types';
import { logEvent } from '../../lib/diagnostics';
import { lookupTrackerDomain, getDisconnectCategory, getDisconnectEntity, isTrackerDomain } from './database-loader';

export async function enrichTrackers(
    url: string,
    domTrackers: { url: string; type: string; domain: string }[],
    networkRequests: Record<string, NetworkRequestDetail>
): Promise<TrackerDetail[]> {
    const enriched: TrackerDetail[] = [];
    const seenDomains = new Set<string>();
    // Candidates the databases did not recognise, counted so "0 trackers" on a
    // page full of third-party requests can be told apart from a broken lookup.
    const dropped = { sameParty: 0, notInDatabase: 0 };
    
    const pageHost = new URL(url).hostname;
    
    const processTracker = async (reqUrl: string, domain: string, type: string, source: 'dom' | 'network' | 'both', status: 'active' | 'blocked') => {
        if (seenDomains.has(domain)) return;
        
        // Must be third-party to be a tracker. Compare against explicit dot
        // boundaries so a lookalike domain (e.g. "notexample.com" vs
        // "example.com") is never mistaken for the same party.
        if (domain === pageHost || domain.endsWith('.' + pageHost) || pageHost.endsWith('.' + domain)) {
            dropped.sameParty += 1;
            return;
        }
        
        // Only list domains our databases actually recognize as trackers.
        // The raw DOM list (detectTrackersRaw) contains EVERY third-party
        // script/image/iframe (CDNs, fonts, APIs) - without this filter those
        // would flood the tracker table as "unknown org" non-trackers.
        if (!(await isTrackerDomain(domain))) {
            dropped.notInDatabase += 1;
            return;
        }
        
        const radar = await lookupTrackerDomain(domain);
        const disconnectCat = await getDisconnectCategory(domain);
        const disconnectEntity = await getDisconnectEntity(domain);
        
        // Fallback categorization
        let category: TrackerDetail['category'] = 'unknown';
        if (disconnectCat) {
            category = disconnectCat as TrackerDetail['category'];
        } else if (radar?.category) {
            const c = radar.category.toLowerCase();
            if (c.includes('ad')) category = 'advertising';
            else if (c.includes('analytic')) category = 'analytics';
            else if (c.includes('social')) category = 'social';
            else if (c.includes('cdn')) category = 'cdn';
            else category = 'unknown';
        }
        
        // Ensure valid type
        const validTypes = ['script', 'pixel', 'iframe', 'xhr', 'beacon', 'stylesheet', 'image', 'unknown'];
        const safeType = validTypes.includes(type) ? type as TrackerDetail['type'] : 'unknown';
        
        seenDomains.add(domain);
        
        enriched.push({
            url: reqUrl,
            domain,
            // Org fallback chain: Tracker Radar owner, then Radar display name,
            // then Disconnect entity name - so recognized trackers rarely show
            // as "Unknown org" even when one database lacks the entry.
            organization: radar?.owner || radar?.displayName || disconnectEntity || null,
            category,
            type: safeType,
            status,
            source,
            prevalence: radar?.prevalence || null,
            fingerprinting: radar?.fingerprinting || null
        });
    };
    
    // 1. Process network trackers (has block status)
    for (const req of Object.values(networkRequests)) {
        if (req.isTracker) {
            // Map resource types to our types
            let t = 'unknown';
            if (req.resourceType === 'script') t = 'script';
            else if (req.resourceType === 'image') t = 'pixel'; // Or image
            else if (req.resourceType === 'xmlhttprequest' || req.resourceType === 'fetch') t = 'xhr';
            else if (req.resourceType === 'sub_frame') t = 'iframe';
            else if (req.resourceType === 'ping') t = 'beacon';
            else if (req.resourceType === 'stylesheet') t = 'stylesheet';
            
            await processTracker(req.url, req.domain, t, 'network', req.status === 'blocked' ? 'blocked' : 'active');
        }
    }
    
    // 2. Process DOM trackers (might miss block status if not caught by network monitor)
    for (const dt of domTrackers) {
        if (!seenDomains.has(dt.domain)) {
            await processTracker(dt.url, dt.domain, dt.type, 'dom', 'active');
        } else {
            // Update source to 'both' if already found via network
            const existing = enriched.find(e => e.domain === dt.domain);
            if (existing) existing.source = 'both';
        }
    }
    
    logEvent('enrich', 'debug', 'trackers_enriched', 'Tracker candidates classified', {
        identified: enriched.length,
        droppedSameParty: dropped.sameParty,
        droppedNotInDatabase: dropped.notInDatabase,
        missingOrganization: enriched.filter(tracker => !tracker.organization).length,
    });

    return enriched;
}
