/**
 * =============================================================================
 * PII DETECTION & UPS CALCULATION - Privacy Score System
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This file handles your User Privacy Score (UPS) - a number from 0 to 100
 * that represents how well you're protecting your personal information.
 * 
 * KEY TERMS:
 * - PII = Personally Identifiable Information (email, SSN, credit card, etc.)
 * - UPS = User Privacy Score (your personal score, 0-100)
 * - WSS = Website Safety Score (a website's score, 0-100)
 * 
 * SCORING PHILOSOPHY (Higher = Better):
 * - 100 = Perfect privacy (you haven't shared sensitive data)
 * - 50 = Some exposure (you've shared data on some sites)
 * - 0 = High exposure (you've shared sensitive data on risky sites)
 * 
 * HOW YOUR SCORE CHANGES:
 * 
 * PENALTIES (score goes DOWN):
 * 1. Visiting risky sites: Small penalty based on site's WSS
 * 2. Entering PII: Bigger penalty, especially on unsafe sites
 *    - Password on safe site: -8 points
 *    - Password on risky site: -16 points (2x multiplier!)
 * 
 * RECOVERY (score goes UP):
 * 1. Visiting safe sites (WSS >= 70): Small recovery
 * 2. Safe streak bonus: +2 every 10 consecutive safe sites
 * 
 * PENALTY EXAMPLES:
 * | Field Type     | Base Penalty | On Safe Site (WSS 100) | On Risky Site (WSS 0) |
 * |----------------|--------------|------------------------|----------------------|
 * | SSN            | 10           | 10                     | 20                   |
 * | Credit Card    | 9            | 9                      | 18                   |
 * | Password       | 8            | 8                      | 16                   |
 * | Phone          | 5            | 5                      | 10                   |
 * | Email          | 4            | 4                      | 8                    |
 * | Address        | 3            | 3                      | 6                    |
 * | Name           | 1            | 1                      | 2                    |
 * =============================================================================
 */

import { getSiteSector, isGovernmentDomain, isHighTierField, isSecurityCodeField, isTrustedDomain, sectorNeedsField, normalizeFieldType } from './pii-sectors';
import { logEvent } from './diagnostics';

// ============================================================================
// PII PATTERNS (for content scanning)
// Regular expressions to detect common PII formats
// ============================================================================

/**
 * Regular expressions to detect PII patterns in text.
 * These are used to identify sensitive data WITHOUT storing it.
 */
export const PII_PATTERNS = {
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    phone: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
    ssn: /\b\d{3}-\d{2}-\d{4}\b/,
    creditCard: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
};

/**
 * Result of scanning text for PII patterns.
 */
export interface PIIDetectionResult {
    hasPII: boolean;    // Was any PII found?
    types: string[];    // Which types were found (email, phone, etc.)
    count: number;      // Total number of matches
}

/**
 * Scans text for PII patterns.
 * Used to detect if a page contains visible personal information.
 * 
 * @param text - The text to scan
 * @returns Information about PII found (types and count)
 */
export function detectPII(text: string): PIIDetectionResult {
    const types: string[] = [];
    let count = 0;

    for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
        const matches = text.match(new RegExp(pattern, 'g'));
        if (matches && matches.length > 0) {
            types.push(type);
            count += matches.length;
        }
    }

    return {
        hasPII: types.length > 0,
        types,
        count
    };
}

// ============================================================================
// PENALTY CONFIGURATION
// ============================================================================

/**
 * Base penalties for each PII field type
 * Higher = more sensitive = bigger UPS impact
 */
export const BASE_PENALTIES: Record<string, number> = {
    // Critical (8-10 points)
    ssn: 10,
    creditCard: 9,
    password: 8,

    // High (5-7 points)
    phone: 5,

    // Medium (3-4 points)
    email: 4,
    address: 3,

    // Low (1-2 points)
    name: 1,
    username: 2,

    // One-time codes (2FA / OTP) - ephemeral, but entering them on a risky
    // site is the classic OTP-scam vector, so they cost a little when the
    // site can't be trusted (exempted on verified/safe sites).
    securityCode: 3,
    otp: 3,

    // Default for unknown types
    unknown: 3
};

/**
 * Get base penalty for a field type
 */
export function getBasePenalty(fieldType: string): number {
    // Normalize to a canonical key. Detectors emit display strings such as
    // "credit card"; collapse whitespace and alias them onto the penalty map.
    const normalizedType = fieldType.toLowerCase().replace(/\s+/g, '');
    const aliases: Record<string, string> = {
        creditcard: 'creditCard',
        card: 'creditCard',
        cvv: 'creditCard',
        securitycode: 'securityCode',
        'one-timecode': 'securityCode',
        verificationcode: 'securityCode',
        otp: 'securityCode',
        socialsecurity: 'ssn',
    };
    const key = aliases[normalizedType] || normalizedType;
    // Use ?? so a legitimate zero penalty (security codes) isn't replaced by
    // the unknown-type fallback.
    return BASE_PENALTIES[key] ?? BASE_PENALTIES.unknown;
}

// ============================================================================
// VISIT PENALTY
// ============================================================================

export interface VisitPenaltyResult {
    penalty: number;
    newUPS: number;
    message: string;
}

/**
 * Calculate UPS penalty for visiting a site
 * 
 * Formula: penalty = ((100 - WSS) / 100) * 2
 * - WSS 100 (safe) → 0 penalty
 * - WSS 50 (medium) → 1 penalty
 * - WSS 0 (dangerous) → 2 penalty
 */
export function calculateVisitPenalty(currentUPS: number, siteWSS: number): VisitPenaltyResult {
    // Clamp WSS to valid range
    const clampedWSS = Math.max(0, Math.min(100, siteWSS));

    // Calculate penalty (max 2 per visit)
    const penalty = ((100 - clampedWSS) / 100) * 2;
    const roundedPenalty = Math.round(penalty * 10) / 10; // Round to 1 decimal

    // Apply penalty
    const newUPS = Math.max(0, Math.round((currentUPS - roundedPenalty) * 10) / 10);

    // Generate message
    let message = '';
    if (roundedPenalty > 0) {
        const riskLevel = clampedWSS >= 70 ? 'safe' : clampedWSS >= 40 ? 'medium-risk' : 'risky';
        message = `Visited ${riskLevel} site (WSS ${clampedWSS}): -${roundedPenalty.toFixed(1)} UPS`;
    }

    // The full calculation as one structured record. This used to be five
    // console.log lines drawing a tree, which vanished when devtools closed and
    // left no way to check the arithmetic after the fact.
    logEvent('pii', 'debug', 'visit_penalty', 'Visit penalty calculated', {
        currentUPS,
        siteWSS,
        clampedWSS,
        penalty: roundedPenalty,
        newUPS,
        message,
    });

    return { penalty: roundedPenalty, newUPS, message };
}

// ============================================================================
// PII ENTRY PENALTY
// ============================================================================

export interface PIIPenaltyResult {
    penalty: number;
    newUPS: number;
    message: string;
}

/**
 * Calculate UPS penalty for entering PII
 * 
 * Formula: penalty = basePenalty * contextMultiplier
 * where contextMultiplier = 1 + ((100 - WSS) / 100)
 * 
 * Examples:
 * - Password on WSS 100 site: 8 × 1.0 = 8
 * - Password on WSS 50 site: 8 × 1.5 = 12
 * - Password on WSS 0 site: 8 × 2.0 = 16
 */
export function calculatePIIPenalty(
    currentUPS: number,
    fieldType: string,
    siteWSS: number
): PIIPenaltyResult {
    // Get base penalty for this field type
    const basePenalty = getBasePenalty(fieldType);

    // Clamp WSS to valid range
    const clampedWSS = Math.max(0, Math.min(100, siteWSS));

    // Calculate context multiplier (1.0 to 2.0 based on site risk)
    const contextMultiplier = 1 + ((100 - clampedWSS) / 100);

    // Calculate final penalty
    const penalty = Math.round(basePenalty * contextMultiplier);

    // Apply penalty
    const newUPS = Math.max(0, currentUPS - penalty);

    // Generate message
    const riskLevel = clampedWSS >= 70 ? 'safe' : clampedWSS >= 40 ? 'medium-risk' : 'risky';
    const message = `Entered ${fieldType} on ${riskLevel} site (WSS ${clampedWSS}): -${penalty} UPS`;

    logEvent('pii', 'debug', 'pii_penalty', 'PII entry penalty calculated', {
        fieldType,
        basePenalty,
        siteWSS,
        clampedWSS,
        contextMultiplier: Math.round(contextMultiplier * 100) / 100,
        penalty,
        currentUPS,
        newUPS,
        riskLevel,
    });

    return { penalty, newUPS, message };
}

// ============================================================================
// PII ENTRY EVALUATION (Expected-Use Exemptions)
// ============================================================================

/**
 * Sites with a WSS at or above this threshold are "safe": entering personal
 * info there is treated as expected use and is not penalized.
 */
export const SAFE_WSS_THRESHOLD = 70;

/** Field types that are expected on a login/sign-up page. */
const LOGIN_FIELDS: ReadonlySet<string> = new Set(['password', 'email', 'username']);

/** Field types that are expected on a checkout/payment page. */
const CHECKOUT_FIELDS: ReadonlySet<string> = new Set(['creditcard', 'address']);

export interface PIIEntryContext {
    fieldType: string;
    domain: string;
    siteWSS: number;
    /** Reputation score 0 = on a blacklist. Hard override for all exemptions. */
    isBlacklisted?: boolean;
    /** Domain is on the user's whitelist (they vouched for it). */
    isWhitelisted?: boolean;
    pageContext?: {
        isLoginPage?: boolean;
        isCheckoutPage?: boolean;
    };
}

export type PIIEntryReason =
    | 'blacklisted'      // Penalize: site is on a blacklist, exemptions never apply
    | 'risky'            // Penalize: risky site - we can't verify where the data goes
    | 'unnecessary'      // Penalize: site has no business collecting this data
    | 'whitelisted'      // Exempt: user explicitly vouched for this site
    | 'otp'              // Exempt: one-time codes are ephemeral (verified/safe site)
    | 'government'       // Exempt: government sites legally require this data
    | 'login'            // Exempt: logging in is expected on this page (safe site)
    | 'checkout'         // Exempt: payment details are expected at checkout (safe site)
    | 'curated-sector'   // Exempt: verified site's sector needs this data
    | 'trusted'          // Exempt: verified consumer platform (login/2FA/checkout)
    | 'keyword-sector'   // Exempt: keyword-matched sector needs this data (safe site)
    | 'safe-site';       // Exempt: safe site, expected use

export interface PIIEntryDecision {
    penalize: boolean;
    reason: PIIEntryReason;
    /** Human-readable explanation, for notifications and the dashboard. */
    message: string;
}

/**
 * Decides whether entering a piece of personal info should cost UPS points.
 *
 * The UPS measures *avoidable* exposure, not normal internet use. Entering
 * your password on a login page, a 2FA code, or your SSN on a government or
 * bank site is expected use and never penalized - unless the site is on a
 * blacklist, in which case every exemption is overridden (that's the
 * phishing case we want to catch hard).
 *
 * Exemptions are earned by EVIDENCE OF LEGITIMACY, never by page structure
 * alone: we cannot look at a page and prove where a 2FA code or credit card
 * actually goes. So expected-use exemptions (login, 2FA, checkout) only apply
 * on sites we can vouch for - verified domains or demonstrably safe sites.
 * On risky sites, every sensitive entry is penalized, because that's exactly
 * where the OTP-scam and fake-checkout scenarios live.
 *
 * Order, strongest first:
 * 1. Blacklisted sites     -> always penalize (hard override)
 * 2. Government domains    -> never penalize (legally required)
 * 3. User-whitelisted      -> never penalize (user vouched for the site)
 * 4. Verified domains (curated sectors + trusted platforms):
 *    exempt expected use, except Tier 1 data (e.g. SSN) the sector has no
 *    business collecting -> penalize
 * 5. Safe sites (WSS >= 70): expected use exempt (login/2FA/checkout), with
 *    the SSN red-flag rule and keyword-sector exemptions
 * 6. Everything on risky sites (WSS < 70, not blacklisted, not verified,
 *    not whitelisted) -> penalize, no exemptions
 */
export function evaluatePIIEntry(ctx: PIIEntryContext): PIIEntryDecision {
    const fieldType = normalizeFieldType(ctx.fieldType);

    // 1. Hard override: blacklisted sites are always penalized, no exceptions.
    if (ctx.isBlacklisted) {
        return {
            penalize: true,
            reason: 'blacklisted',
            message: 'This site is flagged as dangerous - entering personal info here is risky.',
        };
    }

    // 2. Government domains legally require sensitive data.
    if (isGovernmentDomain(ctx.domain)) {
        return {
            penalize: false,
            reason: 'government',
            message: 'Government sites require this data - no penalty.',
        };
    }

    // 3. The user explicitly vouched for this site.
    if (ctx.isWhitelisted) {
        return {
            penalize: false,
            reason: 'whitelisted',
            message: 'This site is on your allow list - no penalty.',
        };
    }

    // 4. Verified domains: curated sectors and trusted consumer platforms.
    //    We verified the domain, so data submitted there reaches the real
    //    company - expected use is exempt. The one exception: Tier 1 data
    //    (e.g. SSN) that the site's sector has no business collecting.
    const sector = getSiteSector(ctx.domain);
    const isVerified = (sector && sector.source === 'curated') || isTrustedDomain(ctx.domain);
    if (isVerified) {
        const sectorNeeds = sector ? sectorNeedsField(sector.sector, fieldType) : false;
        if (isHighTierField(fieldType) && !sectorNeeds) {
            return {
                penalize: true,
                reason: 'unnecessary',
                message: 'This type of site has no business asking for this data.',
            };
        }
        if (sector && sector.source === 'curated') {
            return {
                penalize: false,
                reason: 'curated-sector',
                message: 'This verified site needs this data for its service - no penalty.',
            };
        }
        return {
            penalize: false,
            reason: 'trusted',
            message: 'This site is verified - entering this is expected use, no penalty.',
        };
    }

    // 5. Safe sites (WSS >= 70): demonstrably hard for scammers to fake
    //    (clean reputation, minimal trackers, good security headers).
    if (ctx.siteWSS >= SAFE_WSS_THRESHOLD) {
        const sectorNeeds = sector ? sectorNeedsField(sector.sector, fieldType) : false;

        // Red flag: Tier 1 data the sector has no business collecting.
        if (isHighTierField(fieldType) && !sectorNeeds) {
            return {
                penalize: true,
                reason: 'unnecessary',
                message: 'This type of site has no business asking for this data.',
            };
        }

        // Keyword-matched sector (weak signal is enough when the site itself
        // is already safe).
        if (sector && sector.source === 'keyword' && sectorNeeds) {
            return {
                penalize: false,
                reason: 'keyword-sector',
                message: 'This type of site needs this data - no penalty.',
            };
        }

        const pageContext = ctx.pageContext || {};

        // One-time security codes are ephemeral and single-use.
        if (isSecurityCodeField(fieldType)) {
            return {
                penalize: false,
                reason: 'otp',
                message: 'One-time security codes expire quickly - no penalty.',
            };
        }

        // Logging in is expected wherever there's a login form.
        if (pageContext.isLoginPage && LOGIN_FIELDS.has(fieldType)) {
            return {
                penalize: false,
                reason: 'login',
                message: 'Logging in is expected on this page - no penalty.',
            };
        }

        // Payment details are expected at checkout.
        if (pageContext.isCheckoutPage && CHECKOUT_FIELDS.has(fieldType)) {
            return {
                penalize: false,
                reason: 'checkout',
                message: 'Payment details are expected at checkout - no penalty.',
            };
        }

        return {
            penalize: false,
            reason: 'safe-site',
            message: 'Safe site - entering this is expected use, no penalty.',
        };
    }

    // 6. Risky site (WSS < 70), not blacklisted, not verified, not
    //    whitelisted: we have NO evidence the data reaches the right place,
    //    so every sensitive entry is penalized - including 2FA codes and
    //    checkout fields, which is where OTP scams and fake storefronts live.
    return {
        penalize: true,
        reason: 'risky',
        message: isSecurityCodeField(fieldType)
            ? 'We cannot verify where this one-time code goes - entering it on a risky site is dangerous.'
            : 'We cannot verify this site is safe - avoid entering personal info here.',
    };
}

// ============================================================================
// FORM FOCUS PENALTY (Intent Tracking)
// ============================================================================

export interface FocusPenaltyResult {
    penalty: number;
    newUPS: number;
    message: string;
}

/**
 * Calculate smaller penalty for focusing on a sensitive field (intent tracking)
 * This is 20% of the full PII penalty
 */
export function calculateFocusPenalty(
    currentUPS: number,
    fieldType: string,
    siteWSS: number
): FocusPenaltyResult {
    const basePenalty = getBasePenalty(fieldType);
    const clampedWSS = Math.max(0, Math.min(100, siteWSS));
    const contextMultiplier = 1 + ((100 - clampedWSS) / 100);

    // Focus penalty is 20% of full penalty
    const fullPenalty = basePenalty * contextMultiplier;
    const penalty = Math.round(fullPenalty * 0.2 * 10) / 10;

    const newUPS = Math.max(0, Math.round((currentUPS - penalty) * 10) / 10);
    const message = penalty > 0 ? `Focused on ${fieldType} field: -${penalty.toFixed(1)} UPS` : '';

    logEvent('pii', 'debug', 'focus_penalty', 'Focus penalty calculated', {
        fieldType,
        basePenalty,
        clampedWSS,
        fullPenalty: Math.round(fullPenalty * 100) / 100,
        penalty,
        newUPS,
    });

    return { penalty, newUPS, message };
}

// ============================================================================
// RECOVERY SYSTEM
// ============================================================================

export interface RecoveryResult {
    recovery: number;
    newUPS: number;
    newStreak: number;
    message: string;
}

/**
 * Calculate UPS recovery from visiting safe sites
 * 
 * Requirements:
 * - Site must have WSS >= 70 to qualify for recovery
 * - Recovery rate: ((WSS - 70) / 30) × 0.5
 * - Streak bonus: +2 every 10 consecutive safe sites
 * 
 * Examples:
 * - WSS 70: ((70-70)/30) × 0.5 = 0
 * - WSS 85: ((85-70)/30) × 0.5 = 0.25
 * - WSS 100: ((100-70)/30) × 0.5 = 0.5
 */
export function calculateRecovery(
    currentUPS: number,
    siteWSS: number,
    currentStreak: number,
    isUniqueDomain: boolean = false
): RecoveryResult {
    const clampedWSS = Math.max(0, Math.min(100, siteWSS));
    let newStreak = currentStreak;
    let recovery = 0;
    let message = '';

    // Only recover from safe sites (WSS >= 70)
    if (clampedWSS >= 70) {
        if (isUniqueDomain) {
            // Increment safe streak
            newStreak = currentStreak + 1;

            // Calculate base recovery (reduced rate)
            recovery = ((clampedWSS - 70) / 30) * 0.1;

            // Check for streak bonus (every 10 consecutive safe sites)
            if (newStreak > 0 && newStreak % 10 === 0) {
                recovery += 0.5;
                message = `🎉 Safe streak bonus! +0.5 UPS (${newStreak} safe sites in a row)`;
                logEvent('pii', 'debug', 'streak_bonus', 'Safe streak bonus applied', {
                    streak: newStreak,
                    recovery,
                });
            }

            // Round recovery
            recovery = Math.round(recovery * 100) / 100;

            if (recovery > 0 && !message) {
                message = `Safe browsing recovery: +${recovery.toFixed(2)} UPS`;
            }
        }
    } else {
        // Risky site breaks the streak
        if (currentStreak > 0) {
            message = `Safe streak broken (${currentStreak} → 0) by site with WSS ${clampedWSS}`;
            logEvent('pii', 'debug', 'streak_broken', 'Safe streak broken by a risky site', {
                previousStreak: currentStreak,
                siteWSS: clampedWSS,
            });
        }
        newStreak = 0;
    }

    // Apply recovery (cap at 100)
    const newUPS = Math.min(100, Math.round((currentUPS + recovery) * 10) / 10);

    logEvent('pii', 'debug', 'recovery_applied', 'Recovery calculated', {
        siteWSS: clampedWSS,
        isUniqueDomain,
        qualifies: clampedWSS >= 70 && isUniqueDomain,
        streak: `${currentStreak}->${newStreak}`,
        recovery,
        currentUPS,
        newUPS,
    });

    return { recovery, newUPS, newStreak, message };
}

// ============================================================================
// COMBINED VISIT IMPACT (Penalty OR Recovery)
// ============================================================================

export interface VisitImpactResult {
    newUPS: number;
    newStreak: number;
    upsChange: number;
    message?: string;
}

/**
 * Calculate the full impact of visiting a site
 * Combines visit penalty (for risky sites) with recovery (for safe sites)
 */
export function calculateVisitImpact(
    currentUPS: number,
    siteWSS: number,
    currentStreak: number,
    isUniqueDomain: boolean = false
): VisitImpactResult {
    const clampedWSS = Math.max(0, Math.min(100, siteWSS));

    // Safe sites (WSS >= 70): Recovery
    if (clampedWSS >= 70) {
        const recoveryResult = calculateRecovery(currentUPS, clampedWSS, currentStreak, isUniqueDomain);
        return {
            newUPS: recoveryResult.newUPS,
            newStreak: recoveryResult.newStreak,
            upsChange: recoveryResult.recovery,
            message: recoveryResult.message
        };
    }

    // Risky sites (WSS < 70): Penalty + break streak
    const penaltyResult = calculateVisitPenalty(currentUPS, clampedWSS);
    return {
        newUPS: penaltyResult.newUPS,
        newStreak: 0, // Reset streak
        upsChange: -penaltyResult.penalty,
        message: penaltyResult.message || (currentStreak > 0 ? `Streak broken by WSS ${clampedWSS} site` : undefined)
    };
}

// ============================================================================
// LEGACY FUNCTION (for backward compatibility)
// ============================================================================

/**
 * @deprecated Use calculatePIIPenalty or calculateVisitImpact instead
 * Legacy function that calculates UPS based only on PII events count
 */
export function calculateUPS(piiEventsCount: number): number {
    console.warn('[Deprecation] calculateUPS is deprecated. Use granular penalty functions instead.');

    const baseScore = 100;
    const penaltyPerEvent = 5;
    const score = Math.max(0, baseScore - (piiEventsCount * penaltyPerEvent));

    return Math.round(score);
}
