/**
 * =============================================================================
 * STORAGE UTILITY - Saving and Loading Extension Data
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This file provides easy ways to save and load data using Chrome's storage.
 * Think of it like a filing cabinet for the extension - we can store settings,
 * logs, site data, and notifications here.
 * 
 * WHY WE NEED THIS:
 * Chrome extensions can't use normal databases. Instead, we use chrome.storage
 * which saves data locally on your computer. This file wraps that API to make
 * it easier to use throughout the extension.
 * 
 * WHAT WE STORE:
 * 1. Settings - Your preferences (theme, notifications, whitelist/blacklist)
 * 2. App State - Your UPS score, sites analyzed count, safe streak
 * 3. Detector Logs - History of what we've detected on sites (ENCRYPTED)
 * 4. Notifications - Alerts and warnings we've shown you (ENCRYPTED)
 * 5. Cross-Site Exposure - Which sites know your email, phone, etc. (ENCRYPTED)
 * 6. Site Cache - Analyzed data about websites you've visited (ENCRYPTED)
 * 
 * ENCRYPTION:
 * Sensitive data (detectorLogs, notifications, crossSiteExposure) is encrypted
 * with the user's vault key when the vault is unlocked. When locked, writes are
 * either deferred (via the background buffer) or skipped. Reads of encrypted
 * fields are handled by the background service worker which has access to the key.
 * 
 * STORAGE LIMITS:
 * Chrome defaults chrome.storage.local to 10MB. The extension requests
 * `unlimitedStorage` because per-site enriched details (cookies, trackers,
 * network requests) can make individual siteCache entries large, and a heavy
 * user can legitimately exceed 10MB. Counts are still bounded:
 * - Clean up old logs based on retention settings
 * - Limit logs to 5000 entries max
 * - Limit notifications to 100 entries max
 * =============================================================================
 *
 * Locked-vault telemetry is buffered in chrome.storage.session (in-memory)
 * rather than chrome.storage.local, so it is never persisted to disk while the
 * vault is locked.
 */

import { StorageSchema, UserSettings, AppState } from './types';
import { encryptData, decryptData, decryptDataStrict, generateAesKey, exportKey, importKey, DECRYPT_FAILED } from './crypto';
import { captureError, logEvent } from './diagnostics';

// =============================================================================
// IN-MEMORY BUFFER (vault locked)
// Telemetry recorded while the vault is locked is buffered in
// chrome.storage.session (encrypted with an in-memory buffer key) and flushed
// into the vault-encrypted store when the vault is unlocked. Because the
// buffer key and the buffered data both live only in session storage, locked
// entries are cleared when the browser closes - they are never persisted to
// disk in a form a local attacker could decrypt without the master password.
// =============================================================================

const BUFFER_KEY = 'bufferKeyHex';

/**
 * AES key for the locked-vault buffer. Stored in chrome.storage.session so it
 * lives only in memory and is cleared when the browser closes - matching the
 * PRIVACY.md guarantee that locked-vault entries are temporary and never
 * persisted to disk.
 */
export async function getBufferKey(): Promise<CryptoKey> {
    const stored = await chrome.storage.session.get<Record<string, any>>(BUFFER_KEY);
    if (stored[BUFFER_KEY]) return importKey(stored[BUFFER_KEY]);
    const key = await generateAesKey();
    await chrome.storage.session.set({ [BUFFER_KEY]: await exportKey(key) });
    return key;
}

/**
 * Reads a buffered value, transparently decrypting it. Also handles values
 * written by older versions in plaintext.
 */
export async function readBuffer<T = any>(name: string): Promise<T | null> {
    const stored = await chrome.storage.session.get<Record<string, any>>(name);
    const raw = stored[name];
    if (raw === undefined) return null;
    if (typeof raw === 'string') {
        const key = await getBufferKey();
        return (await decryptData<T>(key, raw)) ?? null;
    }
    return raw as T;
}

/** Encrypts and writes a value into the in-memory (session) buffer. */
export async function writeBuffer(name: string, value: any): Promise<void> {
    const key = await getBufferKey();
    await chrome.storage.session.set({ [name]: await encryptData(key, value) });
}

// =============================================================================
// DEFAULT VALUES
// These are used when data doesn't exist yet (first install)
// =============================================================================

/**
 * Default settings for a new user.
 * These are sensible defaults that work well for most people.
 */
const DEFAULT_SETTINGS: UserSettings = {
    enabled: true,                // Extension is active
    notifications: true,          // Show alerts for risky sites
    theme: 'system',              // Match your OS theme (light/dark)
    whitelist: [],                // Sites you've marked as always safe
    blacklist: [],                // Sites you've marked as always dangerous
    logRetentionDays: 30,         // Days to keep activity logs before auto-deletion
    databaseRefreshDays: 7,
    enableCloudTosdr: false,      // Live rating updates defaults to false (privacy-first)
    devMode: false               // Verbose diagnostics are off until explicitly enabled
};

/**
 * Default app state for a new user.
 * Everyone starts with a perfect privacy score!
 */
const DEFAULT_STATE: AppState = {
    ups: 100,                     // User Privacy Score (starts at 100)
    sitesAnalyzed: 0,             // Number of sites we've analyzed
    trackersDetected: 0,          // Total trackers found across all sites
    piiEventsCount: 0,            // Times you've entered personal info
    safeVisitStreak: 0            // Consecutive safe site visits
};

/**
 * Shared implementation for addDetectorLog / addDetectorLogs. Reads the
 * encrypted log array once, appends, applies retention + the 1,000-entry cap,
 * and writes back once.
 */
async function persistDetectorLogs(
    newLogs: Array<Omit<import('./types').DetectorLogEntry, 'id' | 'timestamp'>>,
    key?: CryptoKey | null
): Promise<void> {
    const result = await chrome.storage.local.get('detectorLogs');
    const raw = result.detectorLogs;

    // Decrypt existing logs if they are encrypted
    let logs: import('./types').DetectorLogEntry[];
    if (key && typeof raw === 'string') {
        const decrypted = await decryptDataStrict<import('./types').DetectorLogEntry[]>(key, raw);
        if (decrypted === DECRYPT_FAILED) {
            // The stored journal exists but cannot be read. Writing the new logs
            // would replace it with a one-entry array, so drop only this input.
            captureError('storage', new Error('detectorLogs could not be decrypted'), 'detector_logs_unreadable');
            return;
        }
        logs = decrypted || [];
    } else if (typeof raw === 'string') {
        // Vault is locked and data is encrypted, buffer the new logs in the
        // encrypted session buffer so they are not lost.
        const buffered = (await readBuffer<import('./types').DetectorLogEntry[]>('bufferedDetectorLogs')) || [];
        const stamped = newLogs.map(log => ({
            ...log,
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now()
        }));
        await writeBuffer('bufferedDetectorLogs', [...buffered, ...stamped]);
        return;
    } else {
        logs = (raw || []) as import('./types').DetectorLogEntry[];
    }

    for (const log of newLogs) {
        logs.push({
            ...log,
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now()
        });
    }

    // Cleanup old logs based on retention policy
    const settings = await storage.getSettings();
    const retentionDays = settings.logRetentionDays || 0; // 0 = forever
    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    let filteredLogs = logs;
    if (retentionDays > 0) {
        filteredLogs = logs.filter(l => (now - l.timestamp) < retentionMs);
    }

    // Keep max 5000 logs, remove oldest if exceeded
    if (filteredLogs.length > 5000) {
        filteredLogs = filteredLogs.slice(-5000);
    }

    // Encrypt on write when key is available
    if (key) {
        await storage.set({ detectorLogs: await encryptData(key, filteredLogs) as any });
    } else {
        await storage.set({ detectorLogs: filteredLogs });
    }
}

/**
 * Notification writes read the encrypted list before rewriting it. While the
 * vault is locked that list cannot be decrypted, and writing an empty array over
 * it would erase every stored notification, so the write is refused.
 */
async function notificationsWritable(key: CryptoKey | null): Promise<boolean> {
    if (key) return true;
    const current = await chrome.storage.local.get('notifications');
    if (typeof current.notifications !== 'string') return true;
    logEvent('storage', 'warn', 'notifications_write_blocked_locked', 'Skipped a notification update while the vault is locked');
    return false;
}

export const storage = {
    get: async <K extends keyof StorageSchema>(keys: K | K[]): Promise<Pick<StorageSchema, K>> => {
        return chrome.storage.local.get(keys) as Promise<Pick<StorageSchema, K>>;
    },

    set: async (items: Partial<StorageSchema>): Promise<void> => {
        try {
            await chrome.storage.local.set(items);
        } catch (error: any) {
            if (error?.message?.includes('QUOTA_BYTES') || error?.name === 'QuotaExceededError') {
                // Session log only: writing this to the durable error log during a
                // quota failure would fail the same way it just did.
                logEvent('storage', 'error', 'quota_exceeded', 'chrome.storage.local quota exceeded', {
                    error: String(error),
                });
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('QUOTA_EXCEEDED'));
                } else {
                    chrome.runtime.sendMessage({ type: 'QUOTA_EXCEEDED' }).catch((notifyError) => {
                        logEvent('storage', 'error', 'quota_notify_failed', 'Could not notify the background about the quota failure', {
                            error: String(notifyError),
                        });
                    });
                }
            }
            throw error;
        }
    },

    // Helper to get all settings with defaults applied
    getSettings: async (): Promise<UserSettings> => {
        const result = await chrome.storage.local.get('settings');
        return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
    },

    updateSettings: async (settings: Partial<UserSettings>): Promise<void> => {
        const current = await storage.getSettings();
        await storage.set({ settings: { ...current, ...settings } });
    },

    // Helper to get app state with defaults
    getState: async (): Promise<AppState> => {
        const result = await chrome.storage.local.get('state');
        return { ...DEFAULT_STATE, ...(result.state || {}) };
    },

    // Serializes state writes. A shared chain guarantees every caller's write is
    // applied in order and every returned promise resolves exactly once, the
    // previous debounced implementation could orphan a caller's promise (clearing
    // its timer) and permanently hang the telemetry write queue.
    updateState: (function() {
        let chain: Promise<void> = Promise.resolve();
        // Accepts either a partial patch or a reducer that computes the patch
        // from the freshest state inside the serialized chain. Reducers avoid
        // lost updates when two callers increment a counter concurrently.
        return (state: Partial<AppState> | ((current: AppState) => Partial<AppState>)): Promise<void> => {
            const run = chain.then(async () => {
                const current = await storage.getState();
                const patch = typeof state === 'function' ? state(current) : state;
                await storage.set({ state: { ...current, ...patch } });
            });
            // Keep the chain alive even if this write fails, so later writes still run.
            chain = run.catch((error) => captureError('storage', error, 'state_write_failed'));
            return run;
        };
    })(),

    // ==========================================================================
    // Add a detector log entry.
    // Pass `key` (the vault CryptoKey) to encrypt the log on write.
    // ==========================================================================
    addDetectorLog: async (
        log: Omit<import('./types').DetectorLogEntry, 'id' | 'timestamp'>,
        key?: CryptoKey | null
    ): Promise<void> => {
        await persistDetectorLogs([log], key);
    },

    // Bulk variant: appends many logs with a single read-decrypt-encrypt-write
    // cycle instead of one per entry (used by the page-analysis pipeline).
    addDetectorLogs: async (
        logs: Array<Omit<import('./types').DetectorLogEntry, 'id' | 'timestamp'>>,
        key?: CryptoKey | null
    ): Promise<void> => {
        if (!logs.length) return;
        await persistDetectorLogs(logs, key);
    },

    // Returns the vault CryptoKey from session storage, or null when locked.
    getVaultKey: async (): Promise<CryptoKey | null> => {
        const session = await chrome.storage.session.get<{ cryptoKeyHex?: string }>('cryptoKeyHex');
        return session.cryptoKeyHex ? importKey(session.cryptoKeyHex) : null;
    },

    // Reads detector logs, transparently decrypting them when the vault is
    // unlocked. Returns [] when the vault is locked (data is unreadable).
    getDetectorLogs: async (key?: CryptoKey | null): Promise<any[]> => {
        const result = await chrome.storage.local.get('detectorLogs');
        const raw = result.detectorLogs;
        if (key && typeof raw === 'string') return (await decryptData(key, raw)) || [];
        if (typeof raw === 'string') return []; // locked, cannot decrypt
        return (raw || []) as any[];
    },

    // Removes detector logs matching a predicate, re-encrypting on write.
    removeDetectorLogs: async (
        predicate: (log: any) => boolean,
        key?: CryptoKey | null
    ): Promise<void> => {
        const logs = await storage.getDetectorLogs(key);
        const filtered = logs.filter((log) => !predicate(log));
        if (key) {
            await storage.set({ detectorLogs: await encryptData(key, filtered) as any });
        } else {
            await storage.set({ detectorLogs: filtered });
        }
    },

    // Clean up old logs based on retention policy
    cleanupOldLogs: async (key?: CryptoKey | null): Promise<void> => {
        const settings = await storage.getSettings();
        const retentionDays = settings.logRetentionDays || 0;

        if (retentionDays === 0) return; // Keep forever

        const result = await chrome.storage.local.get('detectorLogs');
        const raw = result.detectorLogs;

        let logs: import('./types').DetectorLogEntry[];
        if (key && typeof raw === 'string') {
            const decrypted = await decryptDataStrict<import('./types').DetectorLogEntry[]>(key, raw);
            if (decrypted === DECRYPT_FAILED) {
                // Never treat an unreadable journal as an empty one: writing the
                // filtered result back would delete every stored log.
                captureError('storage', new Error('detectorLogs could not be decrypted'), 'log_cleanup_unreadable');
                return;
            }
            logs = decrypted || [];
        } else if (typeof raw === 'string') {
            return; // Can't clean up encrypted data without the key
        } else {
            logs = (raw || []) as import('./types').DetectorLogEntry[];
        }

        const now = Date.now();
        const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
        const filteredLogs = logs.filter(l => (now - l.timestamp) < retentionMs);

        if (key) {
            await storage.set({ detectorLogs: await encryptData(key, filteredLogs) as any });
        } else {
            await storage.set({ detectorLogs: filteredLogs });
        }
    },

    // ==========================================================================
    // Canonical clear/reset paths. These REMOVE keys (rather than writing
    // plaintext sentinels over encrypted fields) so the store never ends up in
    // a mixed plaintext/encrypted state. Readers already default to []/{}
    // when a key is absent.
    // ==========================================================================

    // Removes activity logs (detector logs + PII events) and their buffers.
    clearActivityLogs: async (): Promise<void> => {
        await chrome.storage.local.remove([
            'logs',
            'detectorLogs',
            'piiDetections',
            'errorLog',
        ]);
        await chrome.storage.session.remove([
            'bufferedDetectorLogs',
            'bufferedPii',
        ]);
    },

    // Resets the privacy score and wipes browsing-history-derived data.
    resetScore: async (): Promise<void> => {
        await chrome.storage.local.remove([
            'scoreHistory',
            'siteCache',
            'crossSiteExposure',
        ]);
        await chrome.storage.session.remove([
            'bufferedScoreHistory',
            'bufferedSiteCache',
            'bufferedExposure',
        ]);
        await storage.updateState({
            ups: DEFAULT_STATE.ups,
            sitesAnalyzed: DEFAULT_STATE.sitesAnalyzed,
            trackersDetected: DEFAULT_STATE.trackersDetected,
            piiEventsCount: DEFAULT_STATE.piiEventsCount,
            safeVisitStreak: DEFAULT_STATE.safeVisitStreak,
            currentSite: undefined,
        });
    },

    // Full factory reset: clears local + session storage.
    clearAll: async (): Promise<void> => {
        await chrome.storage.local.clear();
        await chrome.storage.session.clear();
    },

    // Get storage usage info
    getStorageUsage: async (): Promise<{ bytesInUse: number; quota: number }> => {
        const bytesInUse = await chrome.storage.local.getBytesInUse();
        // The manifest requests `unlimitedStorage`, so there is no practical cap.
        // Report quota 0 so the UI shows bytes used only. QUOTA_BYTES still
        // returns 10 MB even under unlimitedStorage, so it must not be shown.
        return { bytesInUse, quota: 0 };
    },

    // Cross-site exposure tracking methods

    /**
     * Record that a PII type was shared with a specific domain.
     * Pass `key` (the vault CryptoKey) to encrypt the exposure map on write.
     */
    addExposure: async (fieldType: string, domain: string, key?: CryptoKey | null): Promise<void> => {
        const result = await chrome.storage.local.get('crossSiteExposure');
        const raw = result.crossSiteExposure;

        // Decrypt existing exposure map if it is encrypted
        let exposure: import('./types').CrossSiteExposure;
        if (key && typeof raw === 'string') {
            const decrypted = await decryptDataStrict<import('./types').CrossSiteExposure>(key, raw);
            if (decrypted === DECRYPT_FAILED) {
                captureError('storage', new Error('crossSiteExposure could not be decrypted'), 'exposure_unreadable');
                return;
            }
            exposure = decrypted || {};
        } else if (typeof raw === 'string') {
            // Vault locked and data is encrypted, buffer instead of dropping.
            const buffered = (await readBuffer<import('./types').CrossSiteExposure>('bufferedExposure')) || {};
            if (!buffered[fieldType]) buffered[fieldType] = [];
            if (!buffered[fieldType].includes(domain)) {
                buffered[fieldType].push(domain);
                await writeBuffer('bufferedExposure', buffered);
                console.log(`[Cross-Site Exposure] ${fieldType} buffered for ${buffered[fieldType].length} sites (locked)`);
            }
            return;
        } else {
            exposure = (raw || {}) as import('./types').CrossSiteExposure;
        }

        // Initialize array if needed
        if (!exposure[fieldType]) {
            exposure[fieldType] = [];
        }

        // Add domain if not already tracked
        if (!exposure[fieldType].includes(domain)) {
            exposure[fieldType].push(domain);

            if (key) {
                await storage.set({ crossSiteExposure: await encryptData(key, exposure) as any });
            } else {
                await storage.set({ crossSiteExposure: exposure });
            }
            console.log(`[Cross-Site Exposure] ${fieldType} now shared with ${exposure[fieldType].length} sites`);
        }
    },

    /**
     * Get count of sites that have received a specific PII type.
     * Pass `key` to decrypt if the data is stored encrypted.
     */
    getExposureCount: async (fieldType: string, key?: CryptoKey | null): Promise<number> => {
        const result = await chrome.storage.local.get('crossSiteExposure');
        const raw = result.crossSiteExposure;
        let exposure: import('./types').CrossSiteExposure;
        if (key && typeof raw === 'string') {
            exposure = (await decryptData(key, raw)) || {};
        } else {
            exposure = (typeof raw === 'string' ? {} : raw || {}) as import('./types').CrossSiteExposure;
        }
        return exposure[fieldType]?.length || 0;
    },

    /**
     * Get list of sites that have received a specific PII type.
     * Pass `key` to decrypt if the data is stored encrypted.
     */
    getExposureSites: async (fieldType: string, key?: CryptoKey | null): Promise<string[]> => {
        const result = await chrome.storage.local.get('crossSiteExposure');
        const raw = result.crossSiteExposure;
        let exposure: import('./types').CrossSiteExposure;
        if (key && typeof raw === 'string') {
            exposure = (await decryptData(key, raw)) || {};
        } else {
            exposure = (typeof raw === 'string' ? {} : raw || {}) as import('./types').CrossSiteExposure;
        }
        return exposure[fieldType] || [];
    },

    /**
     * Get all cross-site exposure data.
     * Pass `key` to decrypt if the data is stored encrypted.
     */
    getAllExposure: async (key?: CryptoKey | null): Promise<import('./types').CrossSiteExposure> => {
        const result = await chrome.storage.local.get('crossSiteExposure');
        const raw = result.crossSiteExposure;
        if (key && typeof raw === 'string') {
            return (await decryptData(key, raw)) || {};
        }
        return (typeof raw === 'string' ? {} : raw || {}) as import('./types').CrossSiteExposure;
    },

    // ============================================
    // Notification Methods
    // ============================================

    /**
     * Add a new notification event.
     * Pass `key` (the vault CryptoKey) to encrypt notifications on write.
     */
    addNotification: async (
        notification: Omit<import('./types').NotificationEvent, 'id' | 'timestamp' | 'read'>,
        key?: CryptoKey | null
    ): Promise<string> => {
        const result = await chrome.storage.local.get('notifications');
        const raw = result.notifications;

        // Decrypt existing notifications if they are encrypted
        let notifications: import('./types').NotificationEvent[];
        if (key && typeof raw === 'string') {
            const decrypted = await decryptDataStrict<import('./types').NotificationEvent[]>(key, raw);
            if (decrypted === DECRYPT_FAILED) {
                // Writing an empty list would drop every stored notification.
                captureError('storage', new Error('notifications could not be decrypted'), 'notifications_unreadable');
                return '';
            }
            notifications = decrypted || [];
        } else if (typeof raw === 'string') {
            // Vault locked and data is encrypted, buffer instead of dropping.
            const buffered = (await readBuffer<import('./types').NotificationEvent[]>('bufferedNotifications')) || [];
            const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const newNotification: import('./types').NotificationEvent = {
                ...notification,
                id,
                timestamp: Date.now(),
                read: false
            };
            await writeBuffer('bufferedNotifications', [newNotification, ...buffered].slice(0, 100));
            return id;
        } else {
            notifications = (raw || []) as import('./types').NotificationEvent[];
        }

        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const newNotification: import('./types').NotificationEvent = {
            ...notification,
            id,
            timestamp: Date.now(),
            read: false
        };

        // Add to beginning (most recent first)
        notifications.unshift(newNotification);

        // Keep max 100 notifications
        const trimmedNotifications = notifications.slice(0, 100);

        if (key) {
            await storage.set({ notifications: await encryptData(key, trimmedNotifications) as any });
        } else {
            await storage.set({ notifications: trimmedNotifications });
        }
        return id;
    },

    /**
     * Get all notifications, optionally limited.
     * Pass `key` to decrypt if the data is stored encrypted.
     */
    getNotifications: async (limit?: number, key?: CryptoKey | null): Promise<import('./types').NotificationEvent[]> => {
        const result = await chrome.storage.local.get('notifications');
        const raw = result.notifications;
        let notifications: import('./types').NotificationEvent[];
        if (key && typeof raw === 'string') {
            notifications = (await decryptData(key, raw)) || [];
        } else {
            notifications = (typeof raw === 'string' ? [] : raw || []) as import('./types').NotificationEvent[];
        }
        return limit ? notifications.slice(0, limit) : notifications;
    },

    /**
     * Get count of unread notifications.
     * Pass `key` to decrypt if the data is stored encrypted.
     */
    getUnreadCount: async (key?: CryptoKey | null): Promise<number> => {
        const notifications = await storage.getNotifications(undefined, key);
        return notifications.filter(n => !n.read).length;
    },

    /**
     * Mark a notification as read.
     * Pass `key` to read and re-encrypt.
     */
    markAsRead: async (id: string, key?: CryptoKey | null): Promise<void> => {
        // Resolve the vault key when not supplied so callers without a direct
        // handle to it (the UI) never wipe encrypted notifications by writing
        // back an empty plaintext array.
        const k = key === undefined ? await storage.getVaultKey() : key;
        if (!(await notificationsWritable(k))) return;
        const notifications = await storage.getNotifications(undefined, k);
        const updated = notifications.map(n => n.id === id ? { ...n, read: true } : n);
        if (k) {
            await storage.set({ notifications: await encryptData(k, updated) as any });
        } else {
            await storage.set({ notifications: updated });
        }
    },

    /**
     * Mark all notifications as read.
     * Pass `key` to read and re-encrypt.
     */
    markAllAsRead: async (key?: CryptoKey | null): Promise<void> => {
        const k = key === undefined ? await storage.getVaultKey() : key;
        if (!(await notificationsWritable(k))) return;
        const notifications = await storage.getNotifications(undefined, k);
        const updated = notifications.map(n => ({ ...n, read: true }));
        if (k) {
            await storage.set({ notifications: await encryptData(k, updated) as any });
        } else {
            await storage.set({ notifications: updated });
        }
    },

    /**
     * Clear all notifications. Removes the key so the store never holds a
     * plaintext sentinel where encrypted data used to live.
     */
    clearNotifications: async (): Promise<void> => {
        await chrome.storage.local.remove('notifications');
    },

    /**
     * Remove a specific notification.
     * Pass `key` to read and re-encrypt.
     */
    removeNotification: async (id: string, key?: CryptoKey | null): Promise<void> => {
        const k = key === undefined ? await storage.getVaultKey() : key;
        if (!(await notificationsWritable(k))) return;
        const notifications = await storage.getNotifications(undefined, k);
        const filtered = notifications.filter(n => n.id !== id);
        if (k) {
            await storage.set({ notifications: await encryptData(k, filtered) as any });
        } else {
            await storage.set({ notifications: filtered });
        }
    }
};
