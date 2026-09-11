/**
 * =============================================================================
 * SCORING LIBRARY - How We Calculate Website Safety Scores
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This file contains the math that calculates the "Website Safety Score" (WSS).
 * The WSS tells you how safe or dangerous a website is on a scale from 0 to 100.
 * 
 * SCORING PHILOSOPHY:
 * - Higher scores = BETTER (100 = completely safe, 0 = very dangerous)
 * - Each website is analyzed in 6 different ways (called "detectors")
 * - Each detector gives its own score, then we combine them with different weights
 * 
 * THE 6 DETECTORS AND THEIR WEIGHTS:
 * 1. Reputation (25%): Is this domain on a local blacklist?
 * 2. Tracking (25%): How many third-party trackers are following you?
 * 3. Cookies (15%): Are there tracking or advertising cookies?
 * 4. Fingerprinting (15%): Are scripts attempting to identify the device?
 * 5. Inputs (10%): Are there sensitive fields like password or credit card?
 * 6. Policy (10%): What does the privacy policy say (according to ToS;DR)?
 * 
 * EXAMPLE:
 * If a site has:
 * - Good reputation: 100 × 25% = 25
 * - Some trackers: 60 × 25% = 15
 * - Few cookies: 80 × 15% = 12
 * - A canvas fingerprinting attempt: 70 × 15% = 10.5
 * - Login form: 65 × 10% = 6.5
 * - No policy rating: excluded
 * Final WSS = 69 (generally safe)
 * =============================================================================
 */

import { ScoreBreakdown } from './types';

export const WSS_WEIGHTS = {
    reputation: 0.25,
    tracking: 0.25,
    cookies: 0.15,
    fingerprinting: 0.15,
    input: 0.10,
    policy: 0.10,
} as const;

const FINGERPRINTING_WEIGHTS: Record<string, number> = {
    canvas: 5, webgl: 4, audio: 3, font: 2, navigator: 1,
    webrtc: 3, screen: 1, battery: 1,
};

/** Converts observed fingerprinting techniques into a 0-100 safety score. */
export function calculateFingerprintingScore(techniques: readonly string[]): number {
    const weightedTechniques = [...new Set(techniques)].reduce(
        (total, technique) => total + (FINGERPRINTING_WEIGHTS[technique] ?? 1), 0,
    );
    return validateScore(100 - 12 * Math.log2(weightedTechniques + 1));
}

/**
 * Converts a count of unique third-party tracker domains into a 0-100 safety
 * score (higher = fewer trackers). Uses the same logarithmic decay as the
 * tracking detector so a handful of trackers is penalized sharply while
 * additional ones contribute a diminishing penalty.
 *
 * Examples:
 * - 0 trackers  -> 100
 * - 1 tracker   -> ~61
 * - 5 trackers  -> ~39
 * - 20 trackers -> ~34
 */
export function calculateTrackingScore(trackerCount: number): number {
    const count = Number.isFinite(trackerCount) ? Math.max(0, Math.floor(trackerCount)) : 0;
    if (count === 0) return 100;
    return validateScore(100 - 15 * Math.log2(count + 1));
}

// =============================================================================
// SCORE VALIDATION
// Makes sure scores are always valid numbers between 0 and 100
// =============================================================================

/**
 * Validates and clamps a score to ensure it's a valid number between 0 and 100.
 * 
 * Sometimes calculations might produce weird values (like NaN, undefined, or -5).
 * This function catches those problems and returns a safe, valid score.
 * 
 * @param score - The score to validate (might be undefined, null, or NaN)
 * @param fallback - What to use if the score is invalid (default: 50)
 * @returns A valid score between 0 and 100
 * 
 * EXAMPLES:
 * - validateScore(85) → 85 (valid, no change)
 * - validateScore(150) → 100 (clamped to max)
 * - validateScore(-10) → 0 (clamped to min)
 * - validateScore(undefined) → 50 (uses fallback)
 * - validateScore(NaN) → 50 (uses fallback)
 */
export function validateScore(score: number | undefined | null, fallback: number = 50): number {
    // Check if the score is unusable (undefined, null, or NaN)
    if (score === undefined || score === null || isNaN(score)) {
        console.warn(`[Score Validation] Invalid score detected, using fallback: ${fallback}`);
        return fallback;
    }

    // Clamp the score to be between 0 and 100, and round to whole number
    // Math.max(0, ...) ensures we don't go below 0
    // Math.min(100, ...) ensures we don't go above 100
    return Math.max(0, Math.min(100, Math.round(score)));
}

// =============================================================================
// WEBSITE SAFETY SCORE (WSS) CALCULATION
// The main scoring algorithm that combines all detector scores
// =============================================================================

/**
 * Calculates the Website Safety Score (WSS) for a website.
 * 
 * This is the main function that takes scores from all 6 detectors and
 * combines them into a single overall score. Think of it like calculating
 * a weighted average for a class - some tests count more than others!
 * 
 * combines them into a single overall score. Think of it like calculating
 * a weighted average for a class - some tests count more than others!
 * 
 * @param breakdown - An object containing scores from each detector
 * @returns The overall Website Safety Score (0-100)
 */
export function calculateWSS(breakdown: ScoreBreakdown): number {
    // STEP 1: Validate all input scores to ensure they're usable
    // This prevents weird bugs from invalid numbers
    const validatedBreakdown = {
        reputation: validateScore(breakdown.reputation),
        tracking: validateScore(breakdown.tracking),
        cookies: validateScore(breakdown.cookies),
        fingerprinting: validateScore(breakdown.fingerprinting),
        input: validateScore(breakdown.input),
        policy: validateScore(breakdown.policy)
    };

    // STEP 2: Check if the policy score is a "fallback" (neutral) score
    // Score 50 means "we found a privacy link but no ToS;DR rating"
    // In this case, we exclude policy from the calculation to avoid penalizing
    // sites that simply don't have a ToS;DR rating yet
    const isPolicyFallback = validatedBreakdown.policy === 50;

    // STEP 3: Define the weights for each detector
    // These add up to 100% (1.0)
    const weights: Record<keyof typeof WSS_WEIGHTS, number> = {
        ...WSS_WEIGHTS
    };

    // STEP 4: If policy is a fallback, redistribute its weight to other detectors
    // This ensures the total still adds up to 100%
    if (isPolicyFallback) {
        const policyWeight = weights.policy;
        weights.policy = 0;  // Policy contributes 0

        // We divide each weight by (1 - policyWeight) to scale them up
        const otherTotal = 1 - policyWeight;
        weights.reputation = weights.reputation / otherTotal;
        weights.tracking = weights.tracking / otherTotal;
        weights.cookies = weights.cookies / otherTotal;
        weights.fingerprinting = weights.fingerprinting / otherTotal;
        weights.input = weights.input / otherTotal;

    }

    // STEP 5: Calculate how much each detector contributes to the final score
    // contribution = detector_score × detector_weight
    const contributions = {
        reputation: validatedBreakdown.reputation * weights.reputation,
        tracking: validatedBreakdown.tracking * weights.tracking,
        cookies: validatedBreakdown.cookies * weights.cookies,
        fingerprinting: validatedBreakdown.fingerprinting * weights.fingerprinting,
        input: validatedBreakdown.input * weights.input,
        policy: validatedBreakdown.policy * weights.policy
    };

    // STEP 6: Add up all contributions to get the final score
    const totalWeightedScore =
        contributions.reputation +
        contributions.tracking +
        contributions.cookies +
        contributions.fingerprinting +
        contributions.input +
        contributions.policy;

    // Validate the final score (round it and ensure it's 0-100)
    return validateScore(totalWeightedScore);
}
