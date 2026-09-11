/**
 * =============================================================================
 * POLICY DETECTOR - Checking Privacy Policies with ToS;DR
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This detector checks if a website has a privacy policy and how good it is.
 * We use ToS;DR (Terms of Service; Didn't Read) - a community project that
 * grades privacy policies like school grades from A to E.
 * 
 * WHAT IS ToS;DR?
 * ToS;DR is a website (tosdr.org) where volunteers read privacy policies and
 * grade them. It's like a Yelp review for privacy policies! This saves you
 * from having to read long, confusing legal documents.
 * 
 * HOW IT WORKS:
 * 1. We ask the ToS;DR API if they have a rating for this website
 * 2. If they do, we convert their grade to a score
 * 3. If they don't, we check if the page at least has a privacy policy link
 * 4. No rating and no link = lowest score (25)
 * 
 * SCORING (Higher = Better):
 * Using ToS;DR grades:
 * - A = 100 (Excellent policy - treats your privacy well)
 * - B = 80 (Good policy)
 * - C = 60 (Fair policy)
 * - D = 40 (Poor policy - some concerning clauses)
 * - E = 20 (Bad policy - significant privacy issues)
 * 
 * Fallback scores (when no ToS;DR rating exists):
 * - 50 = Privacy policy link found (neutral - policy exists but unrated)
 * - 25 = No privacy link at all (concerning - no policy visible)
 * 
 * EXAMPLES:
 * - google.com → Grade C → Score 60
 * - duckduckgo.com → Grade A → Score 100
 * - random-site.com with privacy link → Score 50
 * - sketchy-site.com with no privacy link → Score 25
 * =============================================================================
 */

import { logEvent } from '../../lib/diagnostics';

/**
 * The result of privacy policy detection.
 */
export interface PolicyDetectionResult {
    score: number;            // Safety score (0-100, higher = better policy)
    source: 'tosdr' | 'local' | 'fallback';  // Where the score came from
    grade?: string;           // ToS;DR grade (A-E) if available
    serviceName?: string;     // Name of the service from ToS;DR
    serviceId?: number;       // ID of the service from ToS;DR
    hasLocalPolicy: boolean;  // Was a privacy policy link found on the page?
    points?: { title: string; classification: string }[]; // Reasons for the grade
    documents?: { name: string; url: string }[]; // Reference documents
}

/**
 * Local fallback: Detect privacy policy links on page
 */
function detectLocalPrivacyPolicy(): { found: boolean; links: string[] } {
    const links = document.getElementsByTagName('a');
    const policyLinks: string[] = [];

    for (const link of links) {
        const text = link.innerText.toLowerCase();
        const href = link.href.toLowerCase();

        const isPrivacyLink =
            (text.includes('privacy') && text.includes('policy')) ||
            (href.includes('privacy') && href.includes('policy')) ||
            href.includes('/privacy');

        if (isPrivacyLink) {
            policyLinks.push(link.href);
        }
    }

    return {
        found: policyLinks.length > 0,
        links: policyLinks
    };
}

/**
 * Main policy detection function
 * Uses ToS;DR API with fallback to local detection
 */
export async function detectPrivacyPolicy(): Promise<number> {
    console.log('[Policy Detector] Starting analysis...');
    console.log('[Policy] URL:', window.location.href);

    // Also check local policy presence
    const localResult = detectLocalPrivacyPolicy();

    try {
        // Try ToS;DR API first
        const response = await chrome.runtime.sendMessage({
            type: 'CHECK_TOSDR',
            url: window.location.href
        });

        console.log('[Policy] ToS;DR response:', response);

        // Check if we got a valid ToS;DR response with a grade
        if (response && response.found && response.grade) {
            console.log('[Policy] ToS;DR API result:', {
                service: response.serviceName,
                grade: response.grade,
                score: response.score,
                source: 'tosdr'
            });

            // Use the score from ToS;DR (already mapped: A=100, B=80, C=60, D=40, E=20)
            console.log(`[Policy] Grade ${response.grade} → Score ${response.score}`);
            return response.score;
        }

        // ToS;DR didn't find a rating
        logEvent('detector', 'debug', 'policy_no_rating', 'ToS;DR returned no rating for this domain');

    } catch (error) {
        // Network and API failures are expected, so they land in the session log
        // as warnings rather than in the durable error log.
        logEvent('detector', 'warn', 'policy_tosdr_api_failed', 'ToS;DR API check failed', { error: String(error) });
    }

    // Fallback: Use local detection with neutral score
    // If we find a privacy policy link, give neutral score (50)
    // If no link found, give low score (25)
    const fallbackScore = localResult.found ? 50 : 25;

    console.log('[Policy] Fallback score:', {
        hasLocalPolicy: localResult.found,
        linkCount: localResult.links.length,
        score: fallbackScore,
        reason: localResult.found
            ? 'Privacy link found but no ToS;DR rating → neutral (50)'
            : 'No privacy link and no ToS;DR rating → low (25)'
    });

    return fallbackScore;
}

/**
 * Enhanced detection that returns full details for the UI
 */
export async function detectPrivacyPolicyDetailed(): Promise<PolicyDetectionResult> {
    const localResult = detectLocalPrivacyPolicy();

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'CHECK_TOSDR',
            url: window.location.href
        });

        if (response && response.found && response.grade) {
            return {
                score: response.score,
                source: 'tosdr',
                grade: response.grade,
                serviceName: response.serviceName,
                serviceId: response.serviceId,
                hasLocalPolicy: localResult.found,
                points: response.points,
                documents: response.documents
            };
        }
    } catch (error) {
        logEvent('detector', 'warn', 'policy_tosdr_check_failed', 'ToS;DR rating lookup failed', { error: String(error) });
    }

    // Record why the fallback score was chosen. The analyzer logs the score it
    // receives, but only this knows whether the ToS;DR lookup missed, the page
    // had no privacy link, or the link was there and unrated, which are three
    // very different reasons for the same 50.
    const fallbackScore = localResult.found ? 50 : 25;
    logEvent('detector', 'debug', 'policy_fallback_scored', 'Policy detector fell back to local detection', {
        score: fallbackScore,
        hasLocalPolicy: localResult.found,
        linkCount: localResult.links.length,
        reason: localResult.found ? 'privacy link found, no ToS;DR rating' : 'no privacy link, no ToS;DR rating',
    });

    return {
        score: fallbackScore,
        source: localResult.found ? 'local' : 'fallback',
        hasLocalPolicy: localResult.found
    };
}

/**
 * Synchronous version for backward compatibility
 * Only uses local detection (no API call)
 */
export function detectPrivacyPolicySync(): number {
    const localResult = detectLocalPrivacyPolicy();
    return localResult.found ? 50 : 25;
}
