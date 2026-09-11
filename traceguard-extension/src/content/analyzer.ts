/**
 * =============================================================================
 * PAGE ANALYZER - The Privacy Inspection Coordinator
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This is the "coordinator" that runs all privacy detectors on a webpage.
 * Think of it like a building inspector who checks electrical, plumbing, and
 * structure - this analyzer checks trackers, cookies, inputs, and policy.
 * 
 * HOW IT WORKS:
 * 1. When called, it runs 5 different detectors (reputation is checked separately)
 * 2. Each detector examines one aspect of the page's privacy
 * 3. Results are collected and packaged together
 * 4. The data is sent back to be scored and stored
 * 
 * THE 5 DETECTION AREAS:
 * 1. Tracking - Are there third-party trackers following you?
 * 2. Inputs - Are there sensitive form fields (password, credit card)?
 * 3. Cookies - Are there tracking or advertising cookies?
 * 4. Policy  - What does the privacy policy say (ToS;DR rating)?
 * 5. Reputation - Is the domain on any blacklists? (checked by background)

 * 
 * Note: Reputation is checked by the background script, not here, because
 * content scripts can't make cross-origin requests to the reputation APIs.
 * =============================================================================
 */

// Import all the individual detector functions
import { detectTrackingDetailed, detectTrackersRaw } from './detectors/tracking'; // Finds trackers
import { detectSensitiveInputs } from './detectors/input';     // Finds sensitive fields
import { detectPrivacyPolicyDetailed } from './detectors/policy';      // Checks privacy policy
import { detectCookiesDetailed, detectCookiesRaw } from './detectors/cookie';    // Analyzes cookies
import { detectFingerprintingAttempts } from './detectors/fingerprinting';
import { ScoreBreakdown } from '@/lib/types';                  // Type definitions
import { calculateFingerprintingScore } from '@/lib/scoring';
import { logEvent } from '@/lib/diagnostics';

/**
 * Runs one synchronous detector, times it, and records the raw observation next
 * to the score it produced.
 *
 * Without this only the final WSS reaches the diagnostics bundle, so a wrong
 * tracker count, an empty cookie scan, or a detector that quietly bailed cannot
 * be spotted from an exported report. The duration is the other half: the policy
 * detector waits on a network call, and a slow one there delays every analysis.
 */
function runDetector<T>(
    name: string,
    fn: () => T,
    summarize: (result: T) => Record<string, unknown>
): T {
    const startedAt = Date.now();
    try {
        const result = fn();
        logEvent('detector', 'debug', 'detector_ran', `${name} detector`, {
            detector: name,
            ms: Date.now() - startedAt,
            ...summarize(result),
        });
        return result;
    } catch (error) {
        // The caller turns this into page_analysis_failed, which names no
        // detector. Record which one broke before rethrowing.
        logEvent('detector', 'warn', 'detector_threw', `${name} detector threw`, {
            detector: name,
            ms: Date.now() - startedAt,
            error: String(error),
        });
        throw error;
    }
}

export interface DetectionDetails {
    tracking: { count: number; known: number; suspicious: number };
    cookies: { total: number; tracking: number; thirdParty: number };
    input: { total: number; sensitive: number; types: string[] };
    policy: { 
        grade?: string; 
        source: string; 
        score: number;
        serviceId?: number;
        points?: { title: string; classification: string }[];
        documents?: { name: string; url: string }[];
    };
}

export interface PageContext {
    isLoginPage: boolean;    // Page has a password field (login / sign-up)
    isCheckoutPage: boolean; // Page has a payment field (checkout)
}

export interface PageAnalysisResult {
    scores: ScoreBreakdown;
    sensitiveFields: ReturnType<typeof detectSensitiveInputs>['fields'];
    pageContext: PageContext;
    detectionDetails: DetectionDetails;
    rawForEnrichment: {
        cookies: { name: string }[];
        trackers: { url: string; type: string; domain: string }[];
        fingerprinting: { technique: string; scriptUrl: string | null }[];
    };
}

/**
 * Analyze the current page for privacy and security risks
 * Note: Detector logs are saved by the background worker to avoid duplicates
 */
export async function analyzePage(): Promise<PageAnalysisResult> {
    const analyzeStartedAt = Date.now();

    // Run all detectors
    const trackingResult = runDetector('tracking', () => detectTrackingDetailed(), (result) => ({
        weightedCount: result.trackerCount,
        known: result.knownTrackers.length,
        suspicious: result.suspiciousTrackers.length,
        score: result.score,
    }));
    const inputResult = runDetector('input', () => detectSensitiveInputs(), (result) => ({
        high: result.fields.high.length,
        medium: result.fields.medium.length,
        low: result.fields.low.length,
        types: [...new Set([
            ...result.fields.high.map(field => field.type),
            ...result.fields.medium.map(field => field.type),
            ...result.fields.low.map(field => field.type),
        ])],
        score: result.score,
    }));
    const cookieResult = runDetector('cookie', () => detectCookiesDetailed(), (result) => ({
        total: result.total,
        tracking: result.tracking,
        thirdParty: result.thirdParty,
        score: result.score,
    }));
    const fingerprintingAttempts = runDetector('fingerprinting', () => detectFingerprintingAttempts(), (result) => ({
        techniques: [...new Set(result.map(attempt => attempt.technique))],
        score: calculateFingerprintingScore(result.map(attempt => attempt.technique)),
    }));

    // Reputation check is handled by the background service (user and local blacklists).
    // We pass a placeholder here; background will overwrite with actual score
    const reputationScore = 100;

    // Derive the page structure so the PII penalty system can exempt expected
    // use: a password field means login/sign-up, a payment field means checkout.
    const pageContext: PageContext = {
        isLoginPage: inputResult.fields.high.some(field => field.type === 'password'),
        isCheckoutPage: inputResult.fields.high.some(field => field.type === 'credit card'),
    };

    // Privacy policy check with ToS;DR API (async). Timed separately because it
    // is the only detector that waits on the network.
    const policyStartedAt = Date.now();
    const policyResult = await detectPrivacyPolicyDetailed();
    logEvent('detector', 'debug', 'detector_ran', 'policy detector', {
        detector: 'policy',
        ms: Date.now() - policyStartedAt,
        source: policyResult.source,
        grade: policyResult.grade ?? null,
        serviceId: policyResult.serviceId ?? null,
        score: policyResult.score,
    });

    logEvent('scoring', 'debug', 'analyze_page_complete', 'Page analysis finished', {
        host: window.location.hostname,
        ms: Date.now() - analyzeStartedAt,
    });

    return {
        scores: {
            reputation: reputationScore,
            tracking: trackingResult.score,
            cookies: cookieResult.score,
            input: inputResult.score,
            policy: policyResult.score,
            fingerprinting: calculateFingerprintingScore(fingerprintingAttempts.map(attempt => attempt.technique))
        },
        sensitiveFields: inputResult.fields,
        pageContext,
        detectionDetails: {
            tracking: {
                count: trackingResult.trackerCount,
                known: trackingResult.knownTrackers.length,
                suspicious: trackingResult.suspiciousTrackers.length
            },
            cookies: {
                total: cookieResult.total,
                tracking: cookieResult.tracking,
                thirdParty: cookieResult.thirdParty
            },
            input: {
                total: inputResult.fields.high.length + inputResult.fields.medium.length + inputResult.fields.low.length,
                sensitive: inputResult.fields.high.length,
                types: [
                    ...inputResult.fields.high.map(f => f.type),
                    ...inputResult.fields.medium.map(f => f.type),
                    ...inputResult.fields.low.map(f => f.type)
                ].filter((v, i, a) => a.indexOf(v) === i) // unique
            },
            policy: {
                grade: policyResult.grade,
                source: policyResult.source,
                score: policyResult.score,
                serviceId: policyResult.serviceId,
                points: policyResult.points,
                documents: policyResult.documents
            }
        },
        rawForEnrichment: {
            cookies: detectCookiesRaw(),
            trackers: typeof detectTrackersRaw === 'function' ? detectTrackersRaw() : [],
            fingerprinting: fingerprintingAttempts
        }
    };
}
