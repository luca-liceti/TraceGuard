/**
 * =============================================================================
 * BACKGROUND SERVICE WORKER - The "Brain" of TraceGuard
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This is the main background script that runs behind the scenes in the browser.
 * Think of it as the "brain" of the TraceGuard extension - it doesn't have a 
 * visible interface, but it's always running and managing everything.
 * 
 * KEY RESPONSIBILITIES:
 * 1. Listens for when the extension is installed or the browser starts up
 * 2. Injects the content script (privacy analyzer) into every webpage you visit
 * 3. Receives messages from other parts of the extension and responds to them
 * 4. Calculates and stores privacy scores for websites
 * 5. Tracks when you enter personal information (PII) on websites
 * 6. Sends notifications when something important happens
 * 
 * HOW IT WORKS:
 * - When you visit a website, this script receives analysis data from the content script
 * - It calculates a "Website Safety Score" (WSS) based on various privacy factors
 * - It updates your "User Privacy Score" (UPS) based on your browsing behavior
 * - It stores all this data so you can view it in the dashboard
 * 
 * IMPORTANT CONCEPTS:
 * - WSS (Website Safety Score): How safe a website is (0-100, higher = safer)
 * - UPS (User Privacy Score): Your overall privacy health (0-100, higher = better)
 * - PII: Personally Identifiable Information (like your email, password, phone number)
 * =============================================================================
 */

import { storage, readBuffer, writeBuffer } from '../lib/storage';
import { recordError } from '../lib/error-log';
import { captureError, enableSessionAccessForUntrustedContexts, installGlobalErrorHandlers, logEvent, setDevMode, setDiagnosticContext } from '../lib/diagnostics';
import { z } from 'zod';
import { loadBlacklist, checkReputation, refreshBlacklistFromRemote } from './services/reputation';
import { calculateWSS, calculateTrackingScore, explainWSS } from '../lib/scoring';
import { SiteRiskData, ScoreHistoryEntry, EnrichedDetectionDetails, FingerprintingDetail, DetectorLogEntry, AppState } from '../lib/types';
import { slimSiteData, resolveSyncCurrentSite } from '../lib/site-sync';
import { checkTosDR } from './tosdr-api';
import { calculateVisitImpact, calculatePIIPenalty, evaluatePIIEntry, PIIEntryDecision } from '../lib/pii';
import { encryptData, decryptData, importKey } from '../lib/crypto';
import { preWarmDatabases, lookupTrackerDomain } from './services/database-loader';
import { initNetworkMonitor, getAndClearNetworkData, setNetworkMonitorEnabled } from './services/network-monitor';
import { enrichCookies } from './services/cookie-enricher';
import { enrichTrackers } from './services/tracker-enricher';
import { analyzeHeaders, computeHeaderGrade } from './services/header-analyzer';
import { isLocalUrl } from '../lib/utils';
import { runDataMigrations } from './services/migrations';
import i18n from '../lib/i18n';

// The User Privacy Score chart offers Today / 7-day / 30-day views, so the
// rolling score history must cover at least a month of visits (one entry is
// written per page load + per PII event). A 100-entry cap silently truncated
// the 7/30-day views to a few days of real data.
const SCORE_HISTORY_LIMIT = 5000;

// Serializes read-modify-write workflows. MV3 can handle messages concurrently;
// without this queue, two visits can overwrite each other's encrypted cache/history.
let telemetryWriteQueue: Promise<void> = Promise.resolve();
function queueTelemetryWrite(task: () => Promise<void>): Promise<void> {
    const next = telemetryWriteQueue.then(task, task);
    telemetryWriteQueue = next.catch(error => console.error('[Storage] Queued write failed:', error));
    return next;
}

async function createNotification(
    notification: Parameters<typeof storage.addNotification>[0],
    key?: CryptoKey | null
) {
    await storage.addNotification(notification, key);
    const settings = await storage.getSettings();
    if (!settings.notifications || settings.notificationLevel === 'silent') return;
    if (settings.notificationLevel === 'balanced' && notification.severity === 'info') return;
    try {
        const params = notification.params ? { ...notification.params } : undefined;
        if (params && typeof params.fieldType === 'string') {
            params.fieldType = i18n.t(params.fieldType);
        }
        const title = notification.titleKey ? i18n.t(notification.titleKey, params) : notification.title;
        const message = notification.messageKey ? i18n.t(notification.messageKey, params) : notification.message;
        await chrome.notifications.create(`notif-${Date.now()}`, {
            type: 'basic', iconUrl: 'src/assets/icons/icon-128.png', title,
            message, priority: notification.severity === 'critical' ? 2 : 1,
        });
    } catch (error) {
        // An OS notification must never prevent the local event from being saved.
        console.warn('[Notifications] Unable to create OS notification:', error);
    }
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
    // Notifications are stored encrypted whenever the vault has been set up,
    // so decrypt before looking up the clicked id. Without this, every click
    // would fall through to the generic dashboard.
    const key = await getCryptoKey();
    const result = await chrome.storage.local.get('notifications');
    const raw = result.notifications;
    let notifications: any[] = [];
    if (typeof raw === 'string') {
        if (key) notifications = (await decryptData<any[]>(key, raw)) || [];
    } else {
        notifications = Array.isArray(raw) ? raw : [];
    }
    const notification = notifications.find((n: any) => n.id === notificationId);
    
    if (notification && notification.actionUrl) {
        chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/index.html#${notification.actionUrl}`) });
    } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/index.html') });
    }
});

const DATABASE_REFRESH_ALARM = 'databaseRefresh';
const CLEANUP_ALARM = 'cleanupLogs';
const DATABASE_REFRESH_OPTIONS = new Set([1, 3, 7, 14, 30]);

async function configureDatabaseRefresh(days: number | undefined) {
    const refreshDays = DATABASE_REFRESH_OPTIONS.has(days ?? 7) ? days ?? 7 : 7;
    await chrome.alarms.create(DATABASE_REFRESH_ALARM, { periodInMinutes: refreshDays * 24 * 60 });
}

// =============================================================================
// TAB TRACKING
// Keeps the global state in sync with the active tab for the UI (Sidebar/Popup)
// =============================================================================
async function syncActiveTabSiteData(tabUrl: string | undefined) {
    if (!tabUrl || tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('about:')) {
        const currentState = await storage.getState();
        if (currentState.currentSite) {
            // Pass only the changed field so concurrent counter writes are never clobbered.
            await storage.updateState({ currentSite: undefined });
        }
        return;
    }
    try {
        const domain = new URL(tabUrl).hostname;
        const key = await getCryptoKey();
        let siteCache: Record<string, import('../lib/types').SiteRiskData> = {};
        
        if (key) {
            const result = await chrome.storage.local.get<Record<string, any>>('siteCache');
            siteCache = typeof result.siteCache === 'string' 
                ? await decryptData(key, result.siteCache) || {} 
                : result.siteCache || {};
        } else {
            siteCache = (await readBuffer<Record<string, SiteRiskData>>('bufferedSiteCache')) || {};
        }

        const siteData = siteCache[domain];
        const currentState = await storage.getState();

        // Only update if it actually changed to avoid unnecessary re-renders.
        // Persist only non-sensitive fields to plaintext state, the full
        // analysis lives in the encrypted siteCache.
        //
        // This sync's cache read may predate a PAGE_ANALYSIS_RESULT that just
        // landed for the same tab. resolveSyncCurrentSite never downgrades a
        // fresher currentSite, so a fresh analysis is never clobbered back to
        // the "not on any website" empty state.
        const resolution = resolveSyncCurrentSite(domain, siteData, currentState.currentSite);
        if (resolution.changed) {
            await storage.updateState({ currentSite: resolution.next });
        }
    } catch (error) {
        console.error('[TabTracking] Error syncing site data:', error);
        recordError('Tab tracking sync failed', String(error));
    }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        await syncActiveTabSiteData(tab.url);
    } catch (error) {
        console.error('[TabTracking] Error getting activated tab:', error);
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
        await syncActiveTabSiteData(tab.url);
    }
});

async function refreshPrivacyDatabases() {
    try {
        await preWarmDatabases();
    } catch (error) {
        // Bundled/last-known snapshots remain available when an update is offline.
        console.warn('[DatabaseLoader] Scheduled refresh failed; keeping current data:', error);
    }

    // Best-effort signed threat-feed refresh; bundled snapshot remains on failure.
    try {
        await refreshBlacklistFromRemote();
    } catch (error) {
        console.warn('[Reputation] Threat-feed refresh failed; keeping bundled snapshot:', error);
    }
}

async function getCryptoKey(): Promise<CryptoKey | null> {
    const session = await chrome.storage.session.get<Record<string, any>>('cryptoKeyHex');
    if (session.cryptoKeyHex) {
        return importKey(session.cryptoKeyHex);
    }
    return null;
}

async function flushBufferedTelemetry() {
    const key = await getCryptoKey();
    if (!key) return; // Should not happen since UI just set it

    // Buffers are encrypted with the session buffer key, so decrypt each here.
    const [bufferedPii, bufferedScoreHistory, bufferedSiteCache, bufferedDetectorLogs, bufferedNotifications, bufferedExposure] = await Promise.all([
        readBuffer<any[]>('bufferedPii'),
        readBuffer<any[]>('bufferedScoreHistory'),
        readBuffer<Record<string, SiteRiskData>>('bufferedSiteCache'),
        readBuffer<any[]>('bufferedDetectorLogs'),
        readBuffer<any[]>('bufferedNotifications'),
        readBuffer<Record<string, string[]>>('bufferedExposure'),
    ]);
    const local = await chrome.storage.local.get<Record<string, any>>(['piiDetections', 'scoreHistory', 'siteCache', 'detectorLogs', 'notifications', 'crossSiteExposure']);

    const mergeArray = async (storageKey: string, buffered: any[] | null, cap: number) => {
        if (!buffered || buffered.length === 0) return;
        let existing: any[] = typeof local[storageKey] === 'string'
            ? (await decryptData(key, local[storageKey])) || []
            : (local[storageKey] || []);
        existing = [...existing, ...buffered];
        if (existing.length > cap) existing = existing.slice(-cap);
        await chrome.storage.local.set({ [storageKey]: await encryptData(key, existing) });
    };

    await mergeArray('piiDetections', bufferedPii, 100);
    await mergeArray('scoreHistory', bufferedScoreHistory, SCORE_HISTORY_LIMIT);
    await mergeArray('detectorLogs', bufferedDetectorLogs, 5000);
    await mergeArray('notifications', bufferedNotifications, 100);

    // Flush Site Cache
    if (bufferedSiteCache && Object.keys(bufferedSiteCache).length > 0) {
        let cache = typeof local.siteCache === 'string' ? await decryptData(key, local.siteCache) || {} : local.siteCache || {};
        cache = { ...cache, ...bufferedSiteCache };
        await chrome.storage.local.set({ siteCache: await encryptData(key, cache) });
    }

    // Flush Cross-Site Exposure
    if (bufferedExposure && Object.keys(bufferedExposure).length > 0) {
        const exposure = typeof local.crossSiteExposure === 'string' ? await decryptData(key, local.crossSiteExposure) || {} : local.crossSiteExposure || {};
        for (const [fieldType, domains] of Object.entries(bufferedExposure)) {
            exposure[fieldType] = Array.from(new Set([...(exposure[fieldType] || []), ...(domains || [])]));
        }
        await chrome.storage.local.set({ crossSiteExposure: await encryptData(key, exposure) });
    }

    // Clear buffers (they now live in session storage, not local)
    await chrome.storage.session.remove(['bufferedPii', 'bufferedScoreHistory', 'bufferedSiteCache', 'bufferedDetectorLogs', 'bufferedNotifications', 'bufferedExposure']);
    console.log('[Vault] Buffered telemetry flushed to encrypted storage.');
}

// Capture uncaught errors and unhandled rejections from the moment the worker
// starts. Without this, a throw in any async path here disappears silently.
installGlobalErrorHandlers();
setDiagnosticContext('background');
// The worker is the only context that can widen session storage access, which
// the content script needs before any of its events can reach a copied bundle.
enableSessionAccessForUntrustedContexts();

// Initialize the network monitor right away to start observing web requests
initNetworkMonitor();

// Honor the master on/off toggle for the network monitor as soon as settings
// are available (and whenever they change below), and sync developer mode so
// verbose diagnostics start flowing as soon as the worker wakes up.
storage.getSettings().then((settings) => {
    setNetworkMonitorEnabled(settings.enabled !== false);
    setDevMode(settings.devMode === true);
    logEvent('startup', 'debug', 'service_worker_started', 'Service worker started', {
        enabled: settings.enabled !== false,
        devMode: settings.devMode === true,
    });
}).catch(error => {
    captureError('startup', error, 'settings_load_failed');
});

// =============================================================================
// EXTENSION LIFECYCLE EVENTS
// These functions run when the extension is installed or the browser opens
// =============================================================================

/**
 * This runs ONCE when you first install the extension, or when the extension is updated.
 * It sets up all the initial data the extension needs to work properly.
 */
chrome.runtime.onInstalled.addListener(async () => {
    // Run data migrations before initializing anything else. Migrations fail
    // loudly on a bad step; log and continue so a transient storage error never
    // bricks the extension's startup path.
    try {
        await runDataMigrations();
    } catch (error) {
        console.error('[Migrations] Failed on install:', error);
        recordError('Data migration failed', String(error));
    }

    // Load user settings from storage (or use defaults if this is a fresh install)
    const settings = await storage.getSettings();
    await storage.updateSettings(settings);

    // Pre-warm local databases for fast enrichment
    await configureDatabaseRefresh(settings.databaseRefreshDays);
    await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
    await refreshPrivacyDatabases();
    await preWarmDatabases();

    // Load the app's current state (privacy score, sites analyzed count, etc.)
    const state = await storage.getState();
    await storage.updateState(state);

    // Load the list of known dangerous websites (the "blacklist")
    await loadBlacklist();

    // Set up how the extension opens (popup window vs sidebar)
    await configureDisplayMode(settings.displayMode || 'popup');

    // Sync corrupted/missing state from cache
    await syncStateWithCache();
});

/**
 * This runs every time you open the browser (not just when the extension is installed).
 * It makes sure the extension is ready to work with fresh data.
 */
chrome.runtime.onStartup.addListener(async () => {
    // Run data migrations before initializing anything else
    try {
        await runDataMigrations();
    } catch (error) {
        console.error('[Migrations] Failed on startup:', error);
        recordError('Data migration failed', String(error));
    }

    // Reload the blacklist in case it was updated
    await loadBlacklist();

    // Pre-warm local databases
    await preWarmDatabases();

    // Make sure the display mode matches user preferences
    const settings = await storage.getSettings();
    await configureDatabaseRefresh(settings.databaseRefreshDays);
    await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
    await configureDisplayMode(settings.displayMode || 'popup');

    // Sync corrupted/missing state from cache
    await syncStateWithCache();
});

// =============================================================================
// DISPLAY MODE CONFIGURATION
// Lets users choose between popup (small window) or sidebar (panel on the side)
// =============================================================================

/**
 * Configures whether clicking the extension icon opens a popup or a sidebar.
 * 
 * @param mode - Either 'popup' (small floating window) or 'sidebar' (panel on the side)
 */
async function configureDisplayMode(mode: 'popup' | 'sidebar') {
    if (mode === 'sidebar') {
        // Sidebar mode: Disable the popup and make the sidebar open when you click the icon
        await chrome.action.setPopup({ popup: '' });  // Empty string = no popup
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        console.log('Display mode: Sidebar');
    } else {
        // Popup mode: Enable the popup and disable automatic sidebar opening
        await chrome.action.setPopup({ popup: 'src/popup/index.html' });
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
        console.log('Display mode: Popup');
    }
}

// =============================================================================
// STATE RECOVERY / SYNC
// =============================================================================

/**
 * Heals state and scoreHistory if previous dynamic import crashes left them at 0
 * while siteCache correctly accumulated data.
 */
async function syncStateWithCache() {
    try {
        const key = await getCryptoKey();
        if (!key) {
            console.log('[Sync] Vault locked. Skipping sync.');
            return;
        }

        const state = await storage.getState();
        const result = await chrome.storage.local.get<Record<string, any>>(['siteCache', 'scoreHistory']);
        
        let siteCacheData = result.siteCache;
        let historyData = result.scoreHistory;
        
        if (typeof siteCacheData === 'string') {
            siteCacheData = await decryptData(key, siteCacheData) || {};
        }
        if (typeof historyData === 'string') {
            historyData = await decryptData(key, historyData) || [];
        }

        // Failsafe healing for corrupted siteCache
        if (siteCacheData && typeof siteCacheData === 'object' && typeof siteCacheData[0] === 'string') {
            console.warn('[Sync] Detected corrupted siteCache. Healing...');
            siteCacheData = {};
            await chrome.storage.local.set({ siteCache: await encryptData(key, siteCacheData) });
        }

        const siteCache = (siteCacheData || {}) as Record<string, SiteRiskData>;
        const history = (historyData || []) as ScoreHistoryEntry[];
        
        const sites = Object.values(siteCache);
        let updated = false;

        // Sync sitesAnalyzed
        if (sites.length > 0 && state.sitesAnalyzed === 0) {
            console.log('[Sync] Syncing sitesAnalyzed with siteCache...');
            const totalVisits = sites.reduce((sum, site) => sum + (site.visitCount || 1), 0);
            state.sitesAnalyzed = totalVisits;
            
            await storage.updateState(state);
            updated = true;
        }
        
        // Sync scoreHistory
        if (sites.length > 0 && history.length === 0) {
            console.log('[Sync] Rebuilding scoreHistory from siteCache...');
            // Sort by last analyzed
            const sortedSites = sites.filter(s => s.lastAnalyzed).sort((a, b) => Number(a.lastAnalyzed) - Number(b.lastAnalyzed));
            
            let currentUps = 100;
            let streak = 0;
            const newHistory: ScoreHistoryEntry[] = [];
            
            // Replay the history
            for (const site of sortedSites) {
                const impact = calculateVisitImpact(currentUps, site.wss, streak, true);
                currentUps = impact.newUPS;
                streak = impact.newStreak;
                
                newHistory.push({
                    timestamp: Number(site.lastAnalyzed) || Date.now(),
                    ups: currentUps,
                    avgSiteRisk: site.wss,
                    reason: impact.message || `Visited ${site.domain}`
                });
            }
            
            // Keep last SCORE_HISTORY_LIMIT
            if (newHistory.length > SCORE_HISTORY_LIMIT) newHistory.splice(0, newHistory.length - SCORE_HISTORY_LIMIT);
            await chrome.storage.local.set({ scoreHistory: await encryptData(key, newHistory) });
            
            // Update final UPS
            await storage.updateState({
                ...await storage.getState(),
                ups: currentUps,
                safeVisitStreak: streak
            });
            updated = true;
        }

        if (updated) {
            console.log('[Sync] Sync complete.');
        }
    } catch (err) {
        console.error('[Sync] Error syncing state:', err);
        recordError('State sync failed', String(err));
    }
}

// =============================================================================
// CONTENT SCRIPT INJECTION (REMOVED)
// Now using static content_scripts in manifest.json for performance and compliance.
// =============================================================================

// =============================================================================
// VAULT AUTO-LOCK (idle)
// The vault locks after `autoLockTimeout` minutes of *inactivity*. Activity is
// any message the background worker receives (page analyses while browsing, or
// dashboard/sidepanel/popup messages). `armAutoLock` resets the countdown; the
// one-shot alarm fires only if no activity occurs before it expires.
// =============================================================================
let lastAutoLockArm = 0;
const AUTO_LOCK_ARM_THROTTLE_MS = 10_000;

async function armAutoLock(force = false): Promise<void> {
    try {
        const settings = await storage.getSettings();
        const timeout = settings.autoLockTimeout ?? 0;
        if (!(timeout > 0)) {
            await chrome.alarms.clear('autoLockTimer');
            return;
        }
        // Only arm while the vault is actually unlocked (session key present).
        const session = await chrome.storage.session.get('cryptoKeyHex');
        if (!session.cryptoKeyHex) {
            await chrome.alarms.clear('autoLockTimer');
            return;
        }
        // Throttle so bursts of re-analysis messages don't churn the alarm.
        const now = Date.now();
        if (!force && now - lastAutoLockArm < AUTO_LOCK_ARM_THROTTLE_MS) return;
        lastAutoLockArm = now;
        await chrome.alarms.create('autoLockTimer', { delayInMinutes: timeout });
    } catch (err) {
        console.error('[Lock] Failed to arm auto-lock:', err);
    }
}

// =============================================================================
// MESSAGE HANDLING
// Receives and responds to messages from other parts of the extension
// =============================================================================

/**
 * This is the main "message center" of the extension.
 * Other parts of the extension (content scripts, popup, dashboard) send messages here,
 * and this function decides what to do with each type of message.
 * 
 * Think of it like a receptionist who directs calls to the right department.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (_sender.id !== chrome.runtime.id) {
        console.warn('[Security] Rejected message from unknown sender:', _sender.id);
        return;
    }

    // Verbose only: gives the exported log the message sequence around a
    // failure, which is usually what makes one reproducible.
    logEvent('background', 'debug', 'message_received', String(message?.type ?? 'unknown'), {
        tabId: _sender.tab?.id,
    });

    // Any message from the extension counts as activity, reset the idle timer.
    armAutoLock();

    // -------------------------------------------------------------------------
    // REPUTATION CHECK: Is this website known to be dangerous?

    // -------------------------------------------------------------------------
    // REPUTATION CHECK: Is this website known to be dangerous?
    // -------------------------------------------------------------------------
    if (message.type === 'CHECK_REPUTATION') {
        // Get the URL to check (supports both formats for backward compatibility)
        const url = message.url || (message.domain ? `https://${message.domain}` : undefined);

        if (!url || isLocalUrl(url)) {
            console.warn('[Reputation] No URL or domain provided, or is local URL');
            sendResponse({ isBlacklisted: false, score: 100 });  // Assume safe if no URL given
            return true;
        }

        // Check the website's reputation asynchronously
        checkReputation(url).then(reputationResult => {
            const score = typeof reputationResult === 'number' ? reputationResult : reputationResult.score;
            const checks = typeof reputationResult === 'number' ? [] : reputationResult.checks;
            // A score of 0 means the site is blacklisted (dangerous)
            const isBlacklisted = score === 0;
            sendResponse({ isBlacklisted, score, checks });
        }).catch(error => {
            // Fail CLOSED on uncertainty: match checkReputation's own error
            // contract (50 = uncertain), never report a domain as safe (100).
            console.warn('Reputation check failed:', error);
            sendResponse({ isBlacklisted: false, score: 50, checks: ['Reputation check failed — score uncertain'] });
        });

        return true;  // This tells Chrome to wait for our async response
    }

    // -------------------------------------------------------------------------
    // TOSDR CHECK: What's this website's privacy policy rating?
    // ToS;DR stands for "Terms of Service; Didn't Read" - a database of policy ratings
    // -------------------------------------------------------------------------
    if (message.type === 'CHECK_TOSDR') {
        const url = message.url;

        if (!url) {
            console.warn('[ToS;DR] No URL provided');
            sendResponse({ found: false, score: 0, source: 'fallback' });
            return true;
        }

        // Check the ToS;DR database for this website's privacy policy rating
        checkTosDR(url).then(result => {
            sendResponse(result);
        }).catch(error => {
            console.warn('[ToS;DR] Check failed:', error);
            sendResponse({ found: false, score: 0, source: 'fallback' });
        });

        return true;  // Keep the message channel open for the async response
    }

    // -------------------------------------------------------------------------
    // PAGE ANALYSIS RESULT: Process privacy analysis from a webpage
    // This is the main analysis data that comes from the content script
    // -------------------------------------------------------------------------
    if (message.type === 'PAGE_ANALYSIS_RESULT') {
        // Process the analysis in a separate function (it's complex, so we keep it organized)
        queueTelemetryWrite(() => handlePageAnalysis(message, _sender)).then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            recordError('Page analysis failed', String(error));
            sendResponse({ success: false, error: String(error) });
        });
        return true;  // Keep channel open for async response
    }

    // -------------------------------------------------------------------------
    // PII DETECTED: User entered personal information on a website
    // This helps us track potential privacy exposure
    // -------------------------------------------------------------------------
    if (message.type === 'PII_DETECTED') {
        // Remember which tab emitted the event so the confirmation card and
        // toast appear there, not on whatever page happens to be foreground.
        queueTelemetryWrite(() => handlePIIDetection(message, _sender.tab?.id)).then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            recordError('PII detection failed', String(error));
            sendResponse({ success: false, error: String(error) });
        });
        return true;  // Keep channel open for async response
    }

    // -------------------------------------------------------------------------
    // ADD_TO_ALLOWLIST: User vouched for a site in the PII confirmation popup
    // -------------------------------------------------------------------------
    if (message.type === 'ADD_TO_ALLOWLIST') {
        const domain = String(message.domain || '').toLowerCase();
        if (!domain) {
            sendResponse({ success: false, error: 'No domain provided' });
            return true;
        }
        storage.getSettings().then(async (settings) => {
            const whitelist = settings.whitelist || [];
            if (!whitelist.some(w => w.toLowerCase() === domain)) {
                await storage.updateSettings({ whitelist: [...whitelist, domain] });
            }
            sendResponse({ success: true, domain });
        }).catch(error => {
            recordError('Add to allow list failed', String(error));
            sendResponse({ success: false, error: String(error) });
        });
        return true;
    }

    // -------------------------------------------------------------------------
    // PII_CONFIRM_RESULT: User answered the "Is this website safe?" card
    // -------------------------------------------------------------------------
    if (message.type === 'PII_CONFIRM_RESULT') {
        const domain = String(message.domain || '').toLowerCase();
        const pending = pendingPIIConfirms.get(domain);
        if (pending) {
            pendingPIIConfirms.delete(domain);
            if (pending.timer) clearTimeout(pending.timer);
            pending.resolve(message.safe === true);
        }
        sendResponse({ success: true });
        return true;
    }

    // -------------------------------------------------------------------------
    // UNLOCK VAULT: Flushes buffered telemetry to disk
    // -------------------------------------------------------------------------
    if (message.type === 'UNLOCK_VAULT') {
        armAutoLock(true);
        flushBufferedTelemetry().then(() => sendResponse({ success: true }));
        return true;
    }

    // -------------------------------------------------------------------------
    // SETTINGS CHANGED: User updated their settings in the dashboard
    // We need to apply the new settings right away
    // -------------------------------------------------------------------------
    if (message.type === 'SETTINGS_CHANGED') {
        const newSettings = message.settings;

        armAutoLock(true);

        // Update the display mode and refresh schedule immediately.
        setNetworkMonitorEnabled(newSettings.enabled !== false);
        Promise.all([
            configureDisplayMode(newSettings.displayMode || 'popup'),
            configureDatabaseRefresh(newSettings.databaseRefreshDays),
        ])
            .then(() => sendResponse({ success: true }))
            .catch((error) => {
                console.error('Failed to update display mode:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
});

// =============================================================================
// PAGE ANALYSIS HANDLER
// Processes the privacy analysis data received from web pages
// =============================================================================

/**
 * Processes the complete privacy analysis from a webpage.
 * This is one of the most important functions in the extension!
 * 
 * When you visit a website, the content script analyzes it and sends the results here.
 * This function:
 * 1. Gets the website's reputation score
 * 2. Calculates the overall Website Safety Score (WSS)
 * 3. Updates your User Privacy Score (UPS) based on whether the site was safe or risky
 * 4. Stores all the data so you can see it in the dashboard
 * 5. Creates notifications if the site is dangerous
 * 
 * @param message - The analysis data from the content script
 * @param sender - Information about where the message came from
 */
const PageAnalysisSchema = z.object({
    url: z.string(),
    isInitialLoad: z.boolean().optional(),
    scores: z.record(z.string(), z.number()),
    detectionDetails: z.record(z.string(), z.any()).optional(),
    rawForEnrichment: z.object({
        cookies:        z.array(z.any()).max(500).optional(),
        trackers:       z.array(z.any()).max(500).optional(),
        fingerprinting: z.array(z.any()).max(200).optional(),
    }).optional()
}).passthrough();

async function handlePageAnalysis(message: any, sender: chrome.runtime.MessageSender) {
    const parsed = PageAnalysisSchema.safeParse(message);
    if (!parsed.success) {
        console.warn('[handlePageAnalysis] Invalid message payload:', parsed.error);
        return;
    }
    const validMessage = parsed.data;

    if (!validMessage.url || isLocalUrl(validMessage.url)) {
        console.warn('[handlePageAnalysis] URL missing or is local URL:', validMessage.url);
        return;
    }
    message = validMessage;

    // A genuine navigation (the content script's initial analysis of a
    // document load) is scoreable. Mutation-triggered re-analyses of the same
    // page (isInitialLoad === false) must not re-apply penalties or duplicate
    // history, logs, counters, or notifications.
    const isNewNavigation = message.isInitialLoad !== false;

    // Honor the master on/off toggle, ignore analysis while paused.
    const preSettings = await storage.getSettings();
    if (!preSettings.enabled) return;

    // Step 1: Check the website's reputation (is it on any blacklists?)
    const reputationResult = await checkReputation(message.url);
    const reputationScore = typeof reputationResult === 'number' ? reputationResult : reputationResult.score;
    const reputationChecks = typeof reputationResult === 'number' ? [] : reputationResult.checks;

    // Combine all the individual detector scores into one object (tracking may
    // be corrected later from the bundled databases, so it stays a `const` with
    // mutable fields rather than being reassigned).
    const finalScores = { ...message.scores, reputation: reputationScore };

    if (!message.detectionDetails) {
        message.detectionDetails = {};
    }
    message.detectionDetails.reputation = {
        status: reputationScore === 100 ? 'Clean' : 'Suspicious',
        checks: reputationChecks
    };

    // Step 2: Calculate the Website Safety Score (WSS)
    // This combines all 6 detector scores with different weights
    let wss = calculateWSS(finalScores);

    // Extract just the domain name from the full URL
    // For example: "https://www.example.com/page" becomes "www.example.com"
    const domain = new URL(message.url).hostname;
    // Retrieve network data for this tab
    const tabId = sender.tab?.id;
    let networkData = null;
    if (tabId) {
        networkData = await getAndClearNetworkData(tabId);
    }

    // Build enriched data if raw data is provided
    let enrichedDetails: EnrichedDetectionDetails | undefined = undefined;
    if (message.rawForEnrichment) {
        const cookies = await enrichCookies(message.url, message.rawForEnrichment.cookies, networkData?.setCookies || []);
        const trackers = await enrichTrackers(message.url, message.rawForEnrichment.trackers, networkData?.requests || {});
        const headers = analyzeHeaders(networkData?.responseHeaders || []);
        
        const fpRaw = message.rawForEnrichment.fingerprinting || [];
        const fingerprintingItems: FingerprintingDetail[] = await Promise.all(fpRaw.map(async (f: any) => {
            let org = null;
            if (f.scriptUrl) {
                try {
                    const radar = await lookupTrackerDomain(new URL(f.scriptUrl).hostname);
                    org = radar?.owner || radar?.displayName || null;
                } catch (e) {
                    console.warn('[Enrichment] Fingerprint script lookup failed:', e);
                }
            }
            return {
                technique: f.technique,
                detected: true,
                scriptDomain: f.scriptUrl ? new URL(f.scriptUrl).hostname : null,
                organization: org,
                description: `Detected ${f.technique} fingerprinting attempt`,
                risk: 'medium'
            };
        }));
        
        enrichedDetails = {
            cookies: {
                items: cookies.slice(0, 100), // cap stored detail; summary keeps full totals
                summary: {
                    total: cookies.length,
                    active: cookies.filter(c => c.status === 'active').length,
                    blocked: cookies.filter(c => c.status === 'blocked').length,
                    byCategory: cookies.reduce((acc, c) => { acc[c.category] = (acc[c.category] || 0) + 1; return acc; }, {} as Record<string, number>)
                }
            },
            trackers: {
                items: trackers.slice(0, 200), // cap stored detail; summary keeps full totals
                summary: {
                    total: trackers.length,
                    active: trackers.filter(t => t.status === 'active').length,
                    blocked: trackers.filter(t => t.status === 'blocked').length,
                    byCategory: trackers.reduce((acc, t) => { acc[t.category] = (acc[t.category] || 0) + 1; return acc; }, {} as Record<string, number>)
                }
            },
            networkRequests: {
                items: (networkData ? Object.values(networkData.requests) : []).slice(0, 200), // cap stored detail
                summary: {
                    total: networkData ? Object.keys(networkData.requests).length : 0,
                    thirdParty: networkData ? Object.values(networkData.requests).filter(r => r.isThirdParty).length : 0,
                    blocked: networkData ? Object.values(networkData.requests).filter(r => r.status === 'blocked').length : 0,
                    trackerRequests: networkData ? Object.values(networkData.requests).filter(r => r.isTracker).length : 0
                }
            },
            headers: {
                items: headers,
                summary: (() => {
                    const { score, grade } = computeHeaderGrade(headers);
                    return {
                        score,
                        present: headers.filter(h => h.present).length,
                        missing: headers.filter(h => !h.present).length,
                        grade
                    };
                })()
            },
            fingerprinting: {
                items: fingerprintingItems.slice(0, 100), // cap stored detail
                summary: {
                    totalAttempts: fpRaw.length,
                    techniques: fpRaw.map((f: any) => f.technique),
                    riskLevel: fpRaw.length > 0 ? 'medium' : 'none'
                }
            },
            capturedAt: Date.now()
        };
    }

    // The bundled tracker databases (Tracker Radar / EasyPrivacy / Disconnect)
    // are the authoritative tracker list. When enrichment ran, replace the
    // content script's small hardcoded-list score with a score derived from the
    // actual tracked domains, then recompute WSS against that correction.
    if (enrichedDetails) {
        const uniqueTrackers = new Set(enrichedDetails.trackers.items.map(t => t.domain));
        finalScores.tracking = calculateTrackingScore(uniqueTrackers.size);
        wss = calculateWSS(finalScores);
    }

    // Step 3: Create a data object with all the site's information
    const siteData: SiteRiskData = {
        domain,                                    // The website's domain name
        wss,                                       // Website Safety Score (0-100, higher = safer)
        breakdown: finalScores,                    // Individual scores for each detector
        lastAnalyzed: Date.now(),                  // When we analyzed it (timestamp)
        detectionDetails: message.detectionDetails,// Detailed info about what was detected
        enrichedDetails                            // NEW: Rich per-item analysis
    };

    // Step 4: Save this site's data to the cache
    const key = await getCryptoKey();
    let siteCache: Record<string, SiteRiskData> = {};
    
    if (key) {
        const result = await chrome.storage.local.get<Record<string, any>>('siteCache');
        siteCache = typeof result.siteCache === 'string' 
            ? await decryptData(key, result.siteCache) || {} 
            : result.siteCache || {};
    } else {
        siteCache = (await readBuffer<Record<string, SiteRiskData>>('bufferedSiteCache')) || {};
    }

    // Keep track of how many times you've visited this site
    const existingSite = siteCache[domain];

    // Determine if this is a unique domain visit today
    const now = Date.now();
    let isUniqueDomain = false;
    if (!existingSite || !existingSite.lastVisit) {
        isUniqueDomain = true;
    } else {
        const lastVisitDate = new Date(existingSite.lastVisit).toDateString();
        const todayDate = new Date(now).toDateString();
        if (lastVisitDate !== todayDate) {
            isUniqueDomain = true;
        }
    }

    // Add visit tracking to the site data. Count one visit per genuine
    // navigation; SPA re-analyses of the same page must not inflate the count.
    const visitCount = (existingSite?.visitCount || 0) + (isNewNavigation ? 1 : 0);
    siteData.visitCount = visitCount;
    siteData.lastVisit = now;  // Current time in milliseconds

    // Save the updated site data
    siteCache[domain] = siteData;
    // LRU-style cap: retain the most recently analyzed 5000 domains.
    const cacheEntries = Object.entries(siteCache);
    if (cacheEntries.length > 5000) {
        cacheEntries.sort(([, a], [, b]) => Number(a.lastAnalyzed) - Number(b.lastAnalyzed));
        for (const [expiredDomain] of cacheEntries.slice(0, cacheEntries.length - 5000)) delete siteCache[expiredDomain];
    }
    
    if (key) {
        await chrome.storage.local.set({ siteCache: await encryptData(key, siteCache) });
    } else {
        await writeBuffer('bufferedSiteCache', siteCache);
    }

    // Step 5: Update the user's privacy state
    const state = await storage.getState();

    // Check if the tab that sent this analysis is the currently active tab
    let isActiveTab = true;
    if (sender.tab?.id) {
        try {
            const currentTab = await chrome.tabs.get(sender.tab.id);
            isActiveTab = currentTab.active;
        } catch (e) {
            // Tab might be closed
            isActiveTab = false;
        }
    }

    // Calculate how this visit affects your User Privacy Score (UPS).
    // Risky sites penalize on EVERY genuine navigation (revisiting a bad site
    // keeps lowering the score); safe sites recover only on the first visit of
    // the day (isUniqueDomain) so recovery can't be farmed by refreshing.
    // SPA re-analyses of the same page never re-score.
    // Note: `??` (not `||`) so a genuine UPS of 0 is never replaced by the 100
    // fallback - otherwise penalties computed from 100 would "refund" a user
    // who already hit 0 back up toward a full score.
    const upsImpact = isNewNavigation
        ? calculateVisitImpact(state.ups ?? 100, wss, state.safeVisitStreak || 0, isUniqueDomain)
        : null;

    // Save the updated state
    // Count enriched trackers detected on this visit (both active and blocked)
    const newTrackersCount = enrichedDetails ? enrichedDetails.trackers.items.length : 0;
    
    // Only update currentSite if the analysis is from the active tab.
    // Persist only the non-sensitive fields to plaintext state, the full
    // analysis lives (encrypted) in siteCache. The reducer form recomputes
    // counters from the freshest state inside the serialized write chain so
    // concurrent tab analyses can never lose an increment.
    await storage.updateState((current) => ({
        sitesAnalyzed: current.sitesAnalyzed + (isUniqueDomain ? 1 : 0),           // Increment the counter only for unique sites today
        trackersDetected: (current.trackersDetected || 0) + (isNewNavigation ? newTrackersCount : 0), // Accumulate once per genuine navigation
        ...(upsImpact ? { ups: upsImpact.newUPS, safeVisitStreak: upsImpact.newStreak } : {}),
        ...(isActiveTab ? { currentSite: slimSiteData(siteData) } : {}),
    }));

    // Step 6: Prepare the detector journal for this visit. UPS changes are
    // recorded in scoreHistory (below) with a proper reason - the journal only
    // holds real detector events, so there is no UPS bookkeeping entry here.
    const detectorLogsToWrite: Array<Omit<DetectorLogEntry, 'id' | 'timestamp'>> = [];

    // Append a score-history point only on a genuine navigation; SPA
    // re-analyses of the same page must not duplicate the chart.
    if (isNewNavigation && upsImpact) {
        let history: ScoreHistoryEntry[] = [];
        if (key) {
            const histResult = await chrome.storage.local.get<Record<string, any>>('scoreHistory');
            history = typeof histResult.scoreHistory === 'string'
                ? await decryptData(key, histResult.scoreHistory) || []
                : histResult.scoreHistory || [];
        } else {
            history = (await readBuffer<ScoreHistoryEntry[]>('bufferedScoreHistory')) || [];
        }
        
        history.push({
            timestamp: Date.now(),
            ups: upsImpact.newUPS,
            avgSiteRisk: wss,
            reason: upsImpact.message || `Visited ${domain}`
        });

        // Keep a rolling window large enough for the 30-day chart view
        if (history.length > SCORE_HISTORY_LIMIT) history.splice(0, history.length - SCORE_HISTORY_LIMIT);
        
        if (key) {
            await chrome.storage.local.set({ scoreHistory: await encryptData(key, history) });
        } else {
            await writeBuffer('bufferedScoreHistory', history);
        }
    }

    // Step 7: Log detailed information from each detector
    // This creates activity logs that show up in the "Activity Logs" page

    // Prefer the enriched tracker list (from the bundled databases) when it is
    // available; otherwise fall back to the content script's hardcoded-list
    // detection details.
    const enrichedTrackerDomains = enrichedDetails
        ? Array.from(new Set(enrichedDetails.trackers.items.map(t => t.domain)))
        : null;
    const trackingDetails = enrichedTrackerDomains
        ? {
            trackerCount: enrichedTrackerDomains.length,
            knownTrackers: enrichedTrackerDomains,
            suspiciousTrackers: [],
          }
        : (message.detectionDetails?.tracking
            ? {
                trackerCount: message.detectionDetails.tracking.count || 0,
                knownTrackers: Array.isArray(message.detectionDetails.tracking.known)
                    ? message.detectionDetails.tracking.known
                    : new Array(message.detectionDetails.tracking.known || 0).fill('unknown'),
                suspiciousTrackers: Array.isArray(message.detectionDetails.tracking.suspicious)
                    ? message.detectionDetails.tracking.suspicious
                    : new Array(message.detectionDetails.tracking.suspicious || 0).fill('unknown')
              }
            : { trackerCount: 0, knownTrackers: [], suspiciousTrackers: [] });
    const trackingMessage = trackingDetails.trackerCount === 0
        ? 'No third-party trackers detected'
        : `${trackingDetails.trackerCount} trackers detected (${trackingDetails.knownTrackers.length} known)`;

    // Create human-readable messages for each detector
    const detectorMessages = {
        reputation: reputationScore === 100 ? 'Not on any known threat list' : reputationScore === 0 ? 'Domain blacklisted!' : `Domain reputation score: ${reputationScore}`,
        tracking: trackingMessage,
        cookies: finalScores.cookies >= 80 ? 'No tracking cookies detected' : `Tracking cookies detected (safety: ${finalScores.cookies})`,
        inputs: finalScores.input >= 80 ? 'No sensitive input fields' : `Sensitive input fields detected (safety: ${finalScores.input})`,
        policy: finalScores.policy >= 80 ? 'Good privacy policy' : finalScores.policy <= 25 ? 'No privacy policy found' : `Privacy policy concerns (safety: ${finalScores.policy})`
    };

    // Log each detector's findings to storage (6 logs total, one for each detector)

    // REPUTATION: Is this domain known to be dangerous?
    detectorLogsToWrite.push({
        detector: 'reputation',
        domain,
        score: reputationScore,
        details: { isBlacklisted: reputationScore === 0, status: reputationScore === 100 ? 'Clean' : reputationScore === 0 ? 'Blacklisted' : 'Suspicious' },
        message: detectorMessages.reputation
    });

    // TRACKING: How many third-party trackers are on this page?
    detectorLogsToWrite.push({
        detector: 'tracking',
        domain,
        score: finalScores.tracking,
        details: {
            trackerCount: trackingDetails.trackerCount,
            knownTrackers: trackingDetails.knownTrackers,
            suspiciousTrackers: trackingDetails.suspiciousTrackers
        },
        message: detectorMessages.tracking
    });

    // COOKIES: Are there tracking or third-party cookies?
    detectorLogsToWrite.push({
        detector: 'cookies',
        domain,
        score: finalScores.cookies,
        details: message.detectionDetails?.cookies || {},
        message: detectorMessages.cookies
    });

    // INPUTS: Are there sensitive input fields (password, credit card, etc.)?
    detectorLogsToWrite.push({
        detector: 'inputs',
        domain,
        score: finalScores.input,
        details: message.detectionDetails?.input || {},
        message: detectorMessages.inputs
    });

    // POLICY: What's the privacy policy rating (from ToS;DR)?
    detectorLogsToWrite.push({
        detector: 'policy',
        domain,
        score: finalScores.policy,
        details: message.detectionDetails?.policy || {},
        message: detectorMessages.policy
    });

    // Single batched write: avoids six read-decrypt-encrypt-write cycles of the
    // full (up to 1,000-entry) detector log array per page visit. Only write
    // once per genuine navigation so SPA re-analyses don't spam the journal.
    if (isNewNavigation && detectorLogsToWrite.length > 0) {
        await storage.addDetectorLogs(detectorLogsToWrite, key);
    }

    // Step 8: Create notifications for risky sites
    const settings = await storage.getSettings();
    const threshold = settings.wssThreshold || 50;  // User's custom safety threshold

    // Check if this site is dangerous enough to warn the user
    // WSS is a safety score: lower = more dangerous

    // Notify on each genuine navigation, SPA re-analyses must not spam alerts.
    if (isNewNavigation && wss <= 20) {
        // CRITICAL RISK: Score is 20 or below - this site is very dangerous!
        await createNotification({
            type: 'high_risk_site',
            title: 'Critical Risk Site!',
            titleKey: 'Critical Risk Site!',
            message: `${domain} has been flagged as a critical risk with a safety score of ${wss}`,
            messageKey: '{{domain}} has been flagged as a critical risk with a safety score of {{wss}}',
            params: { domain, wss },
            domain,
            severity: 'critical',
            actionUrl: `/overview?viewSite=${encodeURIComponent(domain)}`
        });
    } else if (isNewNavigation && wss < threshold) {
        // WARNING: Site falls below the user's personal safety threshold
        await createNotification({
            type: 'high_risk_site',
            title: 'High Risk Site Detected',
            titleKey: 'High Risk Site Detected',
            message: `${domain} falls below your safety threshold (Score: ${wss})`,
            messageKey: '{{domain}} falls below your safety threshold (Score: {{wss}})',
            params: { domain, wss },
            domain,
            severity: 'warning',
            actionUrl: `/overview?viewSite=${encodeURIComponent(domain)}`
        });
    }

    // Verbose scoring summary. The 1.4.3 cleanup deleted the console.log that
    // printed this, which left the final WSS and its detector breakdown
    // unobservable. Developer mode is now the only place to read them without
    // attaching a debugger. Note that a 100 here can mean a clean page or a
    // detector that threw and fell back to a neutral score.
    const explanation = explainWSS(finalScores);
    logEvent('scoring', 'debug', 'page_analysis_complete', `${domain} scored ${wss}`, {
        host: domain,
        wss,
        isNewNavigation,
        detectorScores: {
            reputation: finalScores.reputation,
            tracking: finalScores.tracking,
            cookies: finalScores.cookies,
            fingerprinting: finalScores.fingerprinting,
            input: finalScores.input,
            policy: finalScores.policy,
        },
        // The audit trail: which weights were applied (policy's weight is
        // redistributed when ToS;DR had no rating) and what each detector
        // actually contributed to the total.
        policyFallback: explanation.policyFallback,
        weights: explanation.weights,
        contributions: Object.fromEntries(
            Object.entries(explanation.contributions).map(([key, value]) => [key, Math.round(value * 10) / 10])
        ),
    });

}

// =============================================================================
// PII DETECTION HANDLER  
// Processes personal information detection events
// =============================================================================

/**
 * Handles when the user enters personal information (PII) on a website.
 * 
 * "PII" stands for Personally Identifiable Information - things like:
 * - Your email address
 * - Your password
 * - Your phone number
 * - Your credit card number
 * 
 * This function:
 * 1. Records that you entered personal info (without storing what you typed!)
 * 2. Applies a penalty to your privacy score (more penalty on risky sites)
 * 3. Tracks which sites have seen your information
 * 4. Creates a notification to keep you informed
 * 
 * IMPORTANT: We NEVER store what you actually typed - only the TYPE of field
 * (e.g., "password field" or "email field"), not the actual values.
 * 
 * @param message - Information about the PII event from the content script
 */
// Domains we've already asked the user to vouch for this browser session.
// Prevents the confirmation popup from spamming on every PII event.
const promptedPIIConfirmDomains = new Set<string>();

/**
 * Resolves the safety score and reputation for the domain that emitted a PII
 * event from the site cache (the authoritative per-domain analysis), rather
 * than from `state.currentSite` (which tracks the active tab and may point at
 * a different site). Falls back to 50/unknown when no analysis exists yet.
 */
async function resolveSiteScore(domain: string, key: CryptoKey | null): Promise<{ wss: number; reputation: number | undefined }> {
    try {
        let siteCache: Record<string, SiteRiskData> = {};
        if (key) {
            const result = await chrome.storage.local.get<Record<string, any>>('siteCache');
            siteCache = typeof result.siteCache === 'string'
                ? await decryptData(key, result.siteCache) || {}
                : result.siteCache || {};
        } else {
            siteCache = (await readBuffer<Record<string, SiteRiskData>>('bufferedSiteCache')) || {};
        }
        const site = siteCache[domain];
        return { wss: site?.wss ?? 50, reputation: site?.breakdown?.reputation };
    } catch (error) {
        console.warn('[PII] Failed to resolve site score:', error);
        return { wss: 50, reputation: undefined };
    }
}

/**
 * Pending "Is this website safe?" confirmations, keyed by domain. The card is
 * shown BEFORE the UPS penalty is applied, so the user can vouch for a site
 * they trust and avoid an unfair penalty; only a dismiss (or a timeout)
 * actually penalizes.
 */
interface PendingPIIConfirm {
    resolve: (safe: boolean) => void;
    timer: ReturnType<typeof setTimeout> | null;
}
const pendingPIIConfirms = new Map<string, PendingPIIConfirm>();
const PII_CONFIRM_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Shows the confirmation card for an outlier site and waits for the user's
 * answer. Resolves `true` only when the user confirms the site is safe; a
 * "Not sure", dismissal, missing content script, or timeout resolves `false`
 * so the entry is still penalized (fail-safe for risky sites).
 */
async function askForSiteConfirmation(
    event: { site: string; fieldType: string },
    decision: PIIEntryDecision,
    siteWSS: number,
    tabId?: number
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const finish = (safe: boolean) => {
            const pending = pendingPIIConfirms.get(event.site);
            if (pending) {
                pendingPIIConfirms.delete(event.site);
                if (pending.timer) clearTimeout(pending.timer);
            }
            resolve(safe);
        };

        // Fail-safe: an unanswered card (closed tab, missed card) falls back to
        // penalizing the entry on a risky site.
        const timer = setTimeout(() => finish(false), PII_CONFIRM_TIMEOUT_MS);
        pendingPIIConfirms.set(event.site, { resolve: finish, timer });

        // Show the card on the tab that actually emitted the PII event, so a
        // background tab can't produce a confusing prompt on an unrelated page.
        // Translate the card here (i18n is already loaded in this worker) and
        // ship the strings with the message, keeping the content script slim.
        const texts = {
            title: i18n.t('Is this website safe?'),
            dismissLabel: i18n.t('Dismiss'),
            bodyPrefix: i18n.t('TraceGuard detected personal info ({{fieldType}}) on', { fieldType: event.fieldType }),
            bodySuffix: i18n.t('and this site doesn\u2019t meet our security checks. Make sure it\u2019s the real site before entering anything.'),
            confirm: i18n.t('It\u2019s safe - add to allow list'),
            notSure: i18n.t('Not sure'),
            note: i18n.t('If this is the real site, confirm to skip the penalty and add it to your allow list. Check the address bar carefully - lookalike domains are a common trick.'),
            added: i18n.t('Added to allow list'),
            addedNote: i18n.t('{{domain}} was added to your allow list. TraceGuard won\u2019t penalize personal info here anymore.', { domain: event.site }),
        };
        const deliver = (id: number) => {
            chrome.tabs.sendMessage(id, {
                type: 'SHOW_PII_CONFIRM',
                data: {
                    domain: event.site,
                    fieldType: event.fieldType,
                    reason: decision.reason,
                    message: decision.message,
                    siteWSS,
                    texts,
                }
            }).catch((error) => {
                // The page may not have the content script (yet) - penalize.
                // Expected-absent, so this is a session warning, not a bug.
                logEvent('pii', 'warn', 'pii_confirm_undeliverable', 'Could not show the PII confirmation card', {
                    error: String(error),
                    domain: event.site,
                });
                finish(false);
            });
        };
        const fallbackToActiveTab = () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]?.id) deliver(tabs[0].id);
                else finish(false);
            });
        };
        if (tabId !== undefined) {
            chrome.tabs.get(tabId).then(() => deliver(tabId)).catch(fallbackToActiveTab);
        } else {
            fallbackToActiveTab();
        }
    });
}

async function handlePIIDetection(message: any, tabId?: number) {
    const event = message.data;
    console.log('[TraceGuard] PII event:', event);

    // A confirmation is already pending for this site - the pending event will
    // cover any further entries, so ignore this duplicate.
    if (pendingPIIConfirms.has(event.site)) {
        console.log('[TraceGuard] Confirmation already pending for', event.site, '- ignoring duplicate PII event');
        return;
    }

    // Get the settings and site score needed to decide whether this entry
    // should be gated on the confirmation card. The final UPS decision is made
    // in finalizePIIDetection against freshly-read state.
    const key = await getCryptoKey();
    const settings = await storage.getSettings();

    // Resolve the emitting site's safety score from the site cache - the active
    // tab's state may point at a different site. Use ?? so a genuine WSS of 0
    // (blacklisted) is never collapsed into the neutral 50 fallback.
    const { wss: siteWSS, reputation: siteReputation } = await resolveSiteScore(event.site, key);

    // Does the user's allow list already vouch for this domain?
    const domainMatches = (dom: string, pattern: string) => dom === pattern || dom.endsWith('.' + pattern);
    const isWhitelisted = (settings.whitelist || []).some(w => domainMatches(event.site.toLowerCase(), w.toLowerCase()));

    // Decide whether this entry is expected use (exempt) or avoidable risk.
    // Exemptions are earned by evidence of legitimacy (verified domains, safe
    // sites, user allow list) - never by page structure alone, because we
    // cannot verify where a 2FA code or credit card actually goes.
    const decision = evaluatePIIEntry({
        fieldType: event.fieldType,
        domain: event.site,
        siteWSS,
        isBlacklisted: siteReputation === 0,
        isWhitelisted,
        pageContext: event.pageContext,
    });

    // Outlier sites (risky WSS or an unnecessary data ask, not blacklisted):
    // ask the user to vouch for the site BEFORE penalizing. The card is the
    // risk gate - confirming adds the site to the allow list and exempts this
    // entry; dismissing (or no answer) applies the penalty. Blacklisted sites
    // are never offered - they're dangerous, not debatable.
    if (decision.penalize && siteReputation !== 0
        && (decision.reason === 'risky' || decision.reason === 'unnecessary')
        && !promptedPIIConfirmDomains.has(event.site)) {
        promptedPIIConfirmDomains.add(event.site);
        // Don't block the telemetry queue while the user reads the card;
        // finalize the event when they answer (or the timeout fires). The
        // finalize queue is handled separately so a storage failure there can
        // never re-trigger a second finalize with a different decision.
        const finalizeQueued = (safe: boolean) => {
            queueTelemetryWrite(() => finalizePIIDetection(event, safe, tabId)).catch((error) => {
                recordError('PII finalize failed', String(error));
            });
        };
        askForSiteConfirmation(event, decision, siteWSS, tabId)
            .then(finalizeQueued)
            .catch((error) => {
                recordError('PII confirmation failed', String(error));
                finalizeQueued(false);
            });
        return;
    }

    await finalizePIIDetection(event, false, tabId);
}

/**
 * Records a PII entry and applies (or waives) the UPS penalty.
 *
 * @param confirmedSafe - true when the user vouched for the site via the
 * confirmation card: the domain is added to the allow list and the entry is
 * treated as expected use (no penalty).
 */
async function finalizePIIDetection(event: any, confirmedSafe: boolean, tabId?: number) {
    // Read existing PII detections and score history first so we can dedupe
    // repeated events for the same field type on the same site.
    const key = await getCryptoKey();
    let piiDetections: any[] = [];
    let scoreHistory: any[] = [];

    if (key) {
        const storageData = await chrome.storage.local.get<Record<string, any>>(['piiDetections', 'scoreHistory']);
        piiDetections = typeof storageData.piiDetections === 'string'
            ? await decryptData(key, storageData.piiDetections) || []
            : storageData.piiDetections || [];
        scoreHistory = typeof storageData.scoreHistory === 'string'
            ? await decryptData(key, storageData.scoreHistory) || []
            : storageData.scoreHistory || [];
    } else {
        const [piiBuffer, historyBuffer] = await Promise.all([
            readBuffer<any[]>('bufferedPii'),
            readBuffer<any[]>('bufferedScoreHistory'),
        ]);
        piiDetections = piiBuffer || [];
        scoreHistory = historyBuffer || [];
    }

    // Entering the same PII type on the same site is one exposure, not many.
    // Skip duplicates (e.g. a form re-rendering mid-typing) so they can't
    // re-apply penalties or spam notifications.
    if (piiDetections.some((p: any) => p.site === event.site && p.fieldType === event.fieldType)) {
        console.log('[TraceGuard] Skipping duplicate PII event:', event.site, event.fieldType);
        return;
    }

    // Get the current app state (privacy score, etc.)
    const state = await storage.getState();
    const settings = await storage.getSettings();

    // Resolve the emitting site's safety score from the site cache - the active
    // tab's state may point at a different site. Use ?? so a genuine WSS of 0
    // (blacklisted) is never collapsed into the neutral 50 fallback.
    const { wss: siteWSS, reputation: siteReputation } = await resolveSiteScore(event.site, key);

    // Does the user's allow list already vouch for this domain?
    const domainMatches = (dom: string, pattern: string) => dom === pattern || dom.endsWith('.' + pattern);
    const isWhitelisted = (settings.whitelist || []).some(w => domainMatches(event.site.toLowerCase(), w.toLowerCase()));

    // Decide whether this entry is expected use (exempt) or avoidable risk.
    // Exemptions are earned by evidence of legitimacy (verified domains, safe
    // sites, user allow list) - never by page structure alone, because we
    // cannot verify where a 2FA code or credit card actually goes.
    let decision = evaluatePIIEntry({
        fieldType: event.fieldType,
        domain: event.site,
        siteWSS,
        isBlacklisted: siteReputation === 0,
        isWhitelisted,
        pageContext: event.pageContext,
    });

    // The user vouched for the site from the confirmation card: add it to the
    // allow list and treat this entry as expected use (no penalty).
    if (confirmedSafe) {
        const whitelist = settings.whitelist || [];
        if (!whitelist.some(w => domainMatches(event.site.toLowerCase(), w.toLowerCase()))) {
            await storage.updateSettings({ whitelist: [...whitelist, event.site] });
        }
        decision = {
            penalize: false,
            reason: 'whitelisted',
            message: 'You confirmed this site is safe - no penalty.',
        };
    }
    const isExempt = !decision.penalize;

    // Only count/penalize avoidable exposures; expected use is logged but free.
    const newPiiCount = isExempt ? state.piiEventsCount : state.piiEventsCount + 1;

    // Calculate the penalty based on:
    // - What type of info you entered (password = bigger penalty than name)
    // - How safe the current website is (risky site = bigger penalty)
    // `??` (not `||`): a genuine UPS of 0 must stay 0, never flip back to 100.
    const { newUPS, penalty } = isExempt
        ? { newUPS: state.ups ?? 100, penalty: 0 }
        : calculatePIIPenalty(state.ups ?? 100, event.fieldType, siteWSS);
    const scoreImpact = -penalty;  // Negative because it's a penalty

    // Record this PII detection event
    // Note: We only store metadata (field TYPE, site, timestamp) - NOT the actual value you typed!
    piiDetections.push({
        timestamp: event.timestamp,        // When it happened
        site: event.site,                  // Which website
        fieldType: event.fieldType,        // What type of field (password, email, etc.)
        sensitivity: event.sensitivity,   // How sensitive (HIGH, MEDIUM, LOW)
        siteWSS: siteWSS,                 // The site's safety score at the time
        scoreImpact: scoreImpact,         // How much this affected your privacy score (0 = expected use)
        exempt: isExempt,                 // True when this was expected use (no penalty)
        exemptReason: isExempt ? decision.reason : undefined  // Why it was exempt
    });

    // Add this event to your score history (for the dashboard graph)
    scoreHistory.push({
        timestamp: Date.now(),
        ups: newUPS,
        avgSiteRisk: state.currentSite?.wss || 0,
        reason: isExempt
            ? `${event.fieldType} entered on ${event.site} (expected use, no penalty)`
            : `PII entered on ${event.site} (${event.sensitivity} sensitivity)`
    });

    // Keep only the last 100 PII events, and a score-history window large
    // enough for the 30-day chart view.
    if (piiDetections.length > 100) piiDetections.splice(0, piiDetections.length - 100);
    if (scoreHistory.length > SCORE_HISTORY_LIMIT) scoreHistory.splice(0, scoreHistory.length - SCORE_HISTORY_LIMIT);

    // Save the updated data
    if (key) {
        await chrome.storage.local.set({ 
            piiDetections: await encryptData(key, piiDetections), 
            scoreHistory: await encryptData(key, scoreHistory) 
        });
    } else {
        await Promise.all([
            writeBuffer('bufferedPii', piiDetections),
            writeBuffer('bufferedScoreHistory', scoreHistory),
        ]);
    }

    // Track which sites have received each type of your personal information
    // This enables the "Your email is known to X sites" feature in the dashboard
    await storage.addExposure(event.fieldType, event.site, key);

    // Update your privacy state with the new score. The reducer form increments
    // piiEventsCount against the freshest state so concurrent events never lose
    // a count.
    await storage.updateState((current) => ({
        piiEventsCount: current.piiEventsCount + (isExempt ? 0 : 1),  // Total times you've shared PII
        ups: newUPS                                                   // Your updated privacy score
    }));

    console.log(isExempt
        ? `[TraceGuard] PII exempted (${decision.reason}): ${event.fieldType} on ${event.site} - UPS unchanged at ${state.ups}`
        : `[TraceGuard] UPS updated: ${state.ups} → ${newUPS} (PII events: ${newPiiCount})`);

    // Expected-use entries (login, 2FA codes, gov sites, verified sectors, or
    // sites the user vouched for via the confirmation card) are logged and
    // exposed but silent: the user already knows they logged in.
    if (isExempt) return;

    // Create a notification to alert you about the PII detection
    // Severity depends on how sensitive the information was
    const notificationSeverity = event.sensitivity === 'HIGH' ? 'critical'
        : event.sensitivity === 'MEDIUM' ? 'warning'
            : 'info';

    await createNotification({
        type: 'pii_detected',
        title: event.sensitivity === 'HIGH' ? 'Sensitive Data Detected!' : 'Personal Data Entered',
        titleKey: event.sensitivity === 'HIGH' ? 'Sensitive Data Detected!' : 'Personal Data Entered',
        message: `${event.fieldType} entered on ${event.site} (${scoreImpact} pts). ${decision.message}`,
        messageKey: '{{fieldType}} entered on {{site}} ({{scoreImpact}} pts). {{reason}}',
        params: { fieldType: event.fieldType, site: event.site, scoreImpact, reason: decision.message },
        domain: event.site,
        severity: notificationSeverity,
        actionUrl: `/overview?viewSite=${encodeURIComponent(event.site)}&section=inputs`
    }, key);

    // Send a toast notification to the webpage (the little popup message in the corner)
    // We only do this if the user has notifications enabled in their settings.
    // Target the tab that emitted the event so a background tab can't trigger
    // a toast on an unrelated page; fall back to the active tab if it's gone.
    if (settings.notifications) {
        const payload = {
            type: 'SHOW_TOAST',
            data: {
                title: i18n.t('TraceGuard Alert'),
                message: i18n.t('Sensitive input detected on {{site}}', { site: event.site }),
                variant: 'warning'
            }
        };
        const emit = (id: number) => {
            chrome.tabs.sendMessage(id, payload).catch(error => {
                // If the toast fails to show, it's not critical - just log it
                console.warn('Failed to send toast notification:', error);
            });
        };
        const fallbackToActiveTab = () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]?.id) emit(tabs[0].id);
            });
        };
        if (tabId !== undefined) {
            chrome.tabs.get(tabId).then(() => emit(tabId)).catch(fallbackToActiveTab);
        } else {
            fallbackToActiveTab();
        }
    }
}

// Auto-lock timer listener
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'autoLockTimer') {
        console.log('[Lock] Auto-lock timer expired. Locking vault.');
        await chrome.storage.session.remove('cryptoKeyHex');
    } else if (alarm.name === DATABASE_REFRESH_ALARM) {
        await refreshPrivacyDatabases();
    } else if (alarm.name === CLEANUP_ALARM) {
        const key = await getCryptoKey();
        await storage.cleanupOldLogs(key);
    }
});


