/**
 * =============================================================================
 * TYPE DEFINITIONS - The Data Blueprints for TraceGuard
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This file contains "type definitions" or "interfaces" - they're like blueprints
 * that describe the shape of data we use throughout the extension. Think of them
 * like forms with specific fields that data must fill in.
 * 
 * WHY WE NEED TYPES:
 * TypeScript uses these to catch bugs before the code runs. For example, if we
 * try to access a property that doesn't exist, TypeScript will warn us. It's like
 * spell-check, but for data!
 * 
 * HOW TO READ THIS FILE:
 * - `interface` defines a "shape" of data with named properties
 * - `type` creates an alias for another type
 * - `?` after a property name means it's optional
 * - `number`, `string`, `boolean` are basic data types
 * - `[]` means an array (list) of that type
 * =============================================================================
 */

// =============================================================================
// ENRICHED DETECTION DETAIL TYPES
// Rich per-item data for cookies, trackers, network requests, headers, fingerprinting
// =============================================================================

/**
 * Detailed information about a single cookie detected on a page.
 * Enriched with organization, purpose, and technical attributes.
 */
export interface CookieDetail {
    name: string;
    domain: string;
    category: 'necessary' | 'functional' | 'analytics' | 'marketing' | 'unclassified';
    organization: string | null;        // e.g. "Google LLC", "Meta Platforms, Inc."
    platform: string | null;            // e.g. "Google Analytics", "Facebook Pixel"
    purpose: string | null;             // Human-readable description
    retentionPeriod: string | null;     // e.g. "2 years", "Session"
    privacyUrl: string | null;          // Link to organization's privacy policy
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;                   // "Strict" | "Lax" | "None" | "unspecified"
    expirationDate: number | null;      // Unix timestamp, null = session cookie
    isThirdParty: boolean;
    invasivenessWeight: number;         // 0-3 scoring weight
    status: 'active' | 'blocked';       // Was this cookie's domain blocked by something?
}

/**
 * Detailed information about a single tracker detected on a page.
 * Enriched with organization, category, and blocking status.
 */
export interface TrackerDetail {
    url: string;                         // Full URL of the tracker resource
    domain: string;                      // Extracted domain
    organization: string | null;         // Parent company from DDG Tracker Radar
    category: 'advertising' | 'analytics' | 'social' | 'content' | 'cryptomining' | 'fingerprinting' | 'functional' | 'cdn' | 'unknown';
    type: 'script' | 'pixel' | 'iframe' | 'xhr' | 'beacon' | 'stylesheet' | 'image' | 'unknown';
    status: 'active' | 'blocked';        // Blocked by browser/extension?
    source: 'dom' | 'network' | 'both'; // How we detected it
    prevalence: number | null;           // How common across the web (DDG data, 0-1)
    fingerprinting: number | null;       // Fingerprinting risk score (0-3, DDG data)
}

/**
 * A single network request logged during page load.
 * Includes tracking classification and block status.
 */
export interface NetworkRequestDetail {
    url: string;
    domain: string;
    resourceType: string;                // "script", "image", "xmlhttprequest", "sub_frame", etc.
    organization: string | null;         // From DDG Tracker Radar
    isTracker: boolean;                  // Matched against privacy blocklists
    isThirdParty: boolean;
    status: 'completed' | 'blocked' | 'failed';
    blockedReason: string | null;        // "net::ERR_BLOCKED_BY_CLIENT" etc.
    timestamp: number;
}

/**
 * Analysis of a single HTTP security/privacy response header.
 */
export interface HeaderAnalysisDetail {
    header: string;                      // e.g. "Content-Security-Policy"
    value: string | null;                // The header value, null if missing
    present: boolean;
    rating: 'good' | 'fair' | 'poor' | 'missing';
    explanation: string;                 // What this header does
    recommendation: string | null;       // How to improve it (null if already good)
}

/**
 * A detected fingerprinting technique attempt.
 */
export interface FingerprintingDetail {
    technique: 'canvas' | 'webgl' | 'audio' | 'font' | 'navigator' | 'screen' | 'battery' | 'webrtc';
    detected: boolean;
    scriptDomain: string | null;         // Which script domain attempted it
    organization: string | null;         // Mapped via DDG Tracker Radar
    description: string;                 // Human-readable explanation
    risk: 'high' | 'medium' | 'low';
}

/**
 * The complete enriched detection result for a single site visit.
 * Populated by the background enrichment pipeline and stored in siteCache.
 * Phase 2 UI reads this to render detailed per-item breakdowns.
 */
export interface EnrichedDetectionDetails {
    cookies: {
        items: CookieDetail[];
        summary: {
            total: number;
            active: number;
            blocked: number;
            byCategory: Record<string, number>;
        };
    };
    trackers: {
        items: TrackerDetail[];
        summary: {
            total: number;
            active: number;
            blocked: number;
            byCategory: Record<string, number>;
        };
    };
    networkRequests: {
        items: NetworkRequestDetail[];
        summary: {
            total: number;
            thirdParty: number;
            blocked: number;
            trackerRequests: number;
        };
    };
    headers: {
        items: HeaderAnalysisDetail[];
        summary: {
            score: number;
            present: number;
            missing: number;
            grade: 'A' | 'B' | 'C' | 'D' | 'F';
        };
    };
    fingerprinting: {
        items: FingerprintingDetail[];
        summary: {
            totalAttempts: number;
            techniques: string[];
            riskLevel: 'high' | 'medium' | 'low' | 'none';
        };
    };
    capturedAt: number;                  // Unix timestamp of when analysis was captured
}

// =============================================================================
// SCORE BREAKDOWN
// The individual scores from each detector
// =============================================================================

/**
 * Contains the safety score from each of the 6 detectors.
 * Each score ranges from 0 (dangerous) to 100 (safe).
 * 
 * These are combined to calculate the overall Website Safety Score (WSS).
 */
export interface ScoreBreakdown {
    reputation: number;  // Is the domain on any blacklists?
    tracking: number;    // How many third-party trackers are on the page?
    cookies: number;     // Are there tracking or third-party cookies?
    input: number;       // Are there sensitive input fields?
    policy: number;      // What's the privacy policy rating?
    /** Fingerprinting safety score. Older cached entries may not have this. */
    fingerprinting?: number;
}

// =============================================================================
// SITE RISK DATA
// Complete information about a website's privacy analysis
// =============================================================================

/**
 * Stores all the analysis data for a single website.
 * This is what we save in the cache for each domain you visit.
 * 
 * SCORING:
 * - wss (Website Safety Score): 0-100, HIGHER = SAFER
 *   - 80-100: Excellent - Very safe
 *   - 60-79:  Good - Generally safe
 *   - 40-59:  Fair - Some concerns
 *   - 20-39:  Poor - Significant risks
 *   - 0-19:   Critical - Avoid entering personal info
 * 
 * NOTE: WRS (Website Risk Score) is DEPRECATED. Use WSS exclusively.
 */
export interface SiteRiskData {
    domain: string;              // The website's domain (e.g., "google.com")
    wss: number;                 // Website Safety Score (0-100, higher = safer)
    breakdown: ScoreBreakdown;   // Individual scores from each detector
    lastAnalyzed: number | string; // When we analyzed it (timestamp or ISO date string)
    visitCount?: number;         // How many times you've visited (optional)
    lastVisit?: number;          // Timestamp of last visit (optional)
    detectionDetails?: {         // Detailed findings from each detector (optional, kept for backward compatibility)
        tracking?: { count: number; known: number; suspicious: number };
        cookies?: { total: number; tracking: number; thirdParty: number };
        input?: { total: number; sensitive: number; types: string[] };
        policy?: { 
            grade?: string; 
            source: string;
            score?: number;
            serviceId?: number;
            points?: { title: string; classification: string }[];
            documents?: { name: string; url: string }[];
        };
        reputation?: { checks: string[]; status: string };
    };
    enrichedDetails?: EnrichedDetectionDetails;  // Rich per-item enriched analysis (Phase 2 UI reads this)
}

// =============================================================================
// DETECTOR LOG TYPES
// Types for logging what the detectors find
// =============================================================================

/**
 * The possible detector categories.
 * Each detector is responsible for analyzing one aspect of privacy.
 */
// 'permissions' is retained for backward compatibility: pre-fix builds wrote
// UPS bookkeeping entries under that label, and stored logs may still contain
// them (the UI filters them out). New code never writes it.
export type DetectorType = 'reputation' | 'tracking' | 'cookies' | 'inputs' | 'policy' | 'permissions';

/**
 * A single log entry from a detector.
 * These are displayed in the "Activity Logs" page in the dashboard.
 */
export interface DetectorLogEntry {
    id: string;                          // Unique identifier for this log entry
    timestamp: number;                   // When this was logged (Unix timestamp)
    detector: DetectorType;              // Which detector created this log
    domain: string;                      // Which website this is for
    score: number;                       // The score that was calculated
    details: Record<string, any>;        // Extra details (varies by detector)
    message: string;                     // Human-readable description
}

// =============================================================================
// USER SETTINGS
// What preferences the user has configured
// =============================================================================

/**
 * User preferences that can be configured in the Settings page.
 * These are stored in chrome.storage and persist across sessions.
 */
export interface UserSettings {
    enabled: boolean;                    // Is the extension turned on?
    notifications: boolean;              // Should we show alerts?
    theme: 'light' | 'dark' | 'system';  // Color theme preference
    whitelist: string[];                 // Domains the user trusts (always safe)
    blacklist: string[];                 // Domains the user blocked (always danger)
    notificationLevel?: 'silent' | 'balanced' | 'aggressive';  // How often to alert
    wssThreshold?: number;               // Safety threshold for warnings
    logRetentionDays?: number;           // How long to keep logs
    enablePIIDetection?: boolean;        // Watch for personal info entry
    displayMode?: 'popup' | 'sidebar';   // How the extension opens
    autoLockTimeout?: number;            // Vault auto-lock timeout in minutes (0 = never)
    databaseRefreshDays?: 1 | 3 | 7 | 14 | 30;
    enableCloudTosdr?: boolean;          // Live rating updates toggle (runtime tosdr.org lookups)
}

// =============================================================================
// HISTORY AND TRACKING
// Types for tracking score changes over time
// =============================================================================

/**
 * A point in the score history graph.
 * Used to show how your privacy score changed over time.
 */
export interface ScoreHistoryEntry {
    timestamp: number;    // When this happened
    ups: number;          // User Privacy Score at this point
    avgSiteRisk: number;  // Average site risk at this point
    reason: string;       // Why the score changed
}

/**
 * Records when you entered personal information on a website.
 * 
 * IMPORTANT: We store the TYPE of field (e.g., "password"), 
 * NOT what you actually typed!
 */
export interface PIIDetectionEvent {
    timestamp: number;              // When it happened
    site: string;                   // Which website
    fieldType: string;              // Type of field (password, email, etc.)
    sensitivity: 'HIGH' | 'MEDIUM' | 'LOW';  // How sensitive the data is
    siteWSS: number;                // How safe was the site when you entered it
    scoreImpact: number;            // How much this affected your score
}

/**
 * Tracks which sites have received each type of your personal info.
 * Example: { "email": ["google.com", "facebook.com"], "password": ["amazon.com"] }
 * 
 * Used to show "Your email is known to 5 sites" in the dashboard.
 */
export interface CrossSiteExposure {
    [fieldType: string]: string[];  // Map of field type to array of domains
}

// =============================================================================
// APPLICATION STATE
// The current runtime state of the extension
// =============================================================================

/**
 * The current state of the extension - what it's tracking right now.
 * This updates as you browse and gets displayed in the popup/sidebar.
 */
export interface AppState {
    ups: number;                 // Your User Privacy Score (0-100, higher = better)
    sitesAnalyzed: number;       // Total count of sites you've visited
    trackersDetected: number;    // Total trackers found across all sites
    piiEventsCount: number;      // How many times you've entered personal info
    currentSite?: SiteRiskData;  // The site you're currently on (if analyzed)
    safeVisitStreak: number;     // Consecutive safe sites visited (for bonus)
}

// =============================================================================
// STORAGE SCHEMA
// The complete structure of what we store in chrome.storage
// =============================================================================

/**
 * The complete schema for everything stored in chrome.storage.local.
 * This is like the "database schema" for the extension.
 */
export interface StorageSchema {
    schemaVersion?: number;                        // For handling upgrades
    settings: UserSettings;                        // User preferences
    state: AppState;                               // Current runtime state
    siteCache: Record<string, SiteRiskData>;       // Cached site analyses
    logs: LogEntry[];                              // General log entries
    detectorLogs?: DetectorLogEntry[];             // Detector-specific logs
    scoreHistory?: ScoreHistoryEntry[];            // Score changes over time
    piiDetections?: PIIDetectionEvent[];           // PII entry events
    crossSiteExposure?: CrossSiteExposure;         // Which sites know your info
    notifications?: NotificationEvent[];           // Alert notifications
    tosdr_cache?: Record<string, unknown>;         // Opt-in ToS;DR policy-lookup cache (domain → grade), plaintext
}

// =============================================================================
// LEGACY AND UTILITY TYPES
// =============================================================================

/**
 * A general log entry (older logging system).
 */
export interface LogEntry {
    id: string;
    timestamp: string;
    type: 'info' | 'warning' | 'error' | 'block';
    message: string;
    domain?: string;
}

/**
 * A notification shown to the user about privacy events.
 * These appear in the notification dropdown in the top navigation.
 */
export interface NotificationEvent {
    id: string;              // Unique identifier
    timestamp: number;       // When it was created
    type: 'high_risk_site' | 'pii_detected' | 'tracker_alert' | 'daily_summary' | 'info';
    title: string;           // Short title for the notification (English fallback)
    message: string;         // Detailed message (English fallback)
    titleKey?: string;       // i18n key for the title (translated at display time)
    messageKey?: string;     // i18n key for the message (translated at display time)
    params?: Record<string, any>; // Interpolation params for titleKey/messageKey
    domain?: string;         // Which website it's about (if applicable)
    severity: 'critical' | 'warning' | 'info';  // How urgent is it?
    read: boolean;           // Has the user seen it?
    actionUrl?: string;      // Where to go when clicked
}

// =============================================================================
// DOMAIN GROUPING
// Bundles multiple visits to the same domain into a collapsible accordion row
// =============================================================================

/**
 * A group of visits to the same domain, used to render accordion rows in the
 * data table. The `summary` row is the parent (aggregated) row shown when
 * collapsed. `visits` are the individual child rows shown when expanded.
 *
 * Aggregation strategy per column:
 * - Safety Level   → worst-case (most severe) across all visits
 * - WSS Score      → average across all visits
 * - Trackers       → max (peak tracking exposure)
 * - Cookies        → max (peak cookie count)
 * - PII Risk       → "Yes" if any visit detected PII
 * - Reputation     → worst-case (Blacklisted > Suspicious > Clean)
 * - Policy Grade   → most recent visit's grade
 * - Headers Grade  → most recent visit's grade
 * - Fingerprinting → max attempts across all visits
 * - Visit Time     → most recent timestamp
 */
export interface DomainGroup {
    domain: string;
    visitCount: number;
    summary: {
        id?: string;
        domain: string;
        timestamp: number;
        wss: number;
        safetyLevel: string;
        trackers: number;
        cookies: number;
        inputs: string;
        reputation: string;
        policy: string;
        headersGrade?: string;
        fingerprintingAttempts?: number;
        details?: any;
    };
    visits: Array<{
        id?: string;
        domain: string;
        timestamp: number;
        wss: number;
        safetyLevel: string;
        trackers: number;
        cookies: number;
        inputs: string;
        reputation: string;
        policy: string;
        headersGrade?: string;
        fingerprintingAttempts?: number;
        details?: any;
    }>;
}
