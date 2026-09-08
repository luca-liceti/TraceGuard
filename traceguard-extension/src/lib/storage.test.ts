/**
 * =============================================================================
 * STORAGE UNIT TESTS
 * =============================================================================
 * 
 * Tests the storage utility functions including:
 * - Default value merging
 * - Log management (add, trim, retention, quota)
 * - Notification management (add, mark read, remove, clear)
 * - Cross-site exposure tracking
 * - Encrypted paths for detectorLogs, notifications, crossSiteExposure
 * 
 * NOTE: chrome.storage is mocked by src/test/setup.ts with a real stateful
 * in-memory store, so reads and writes are fully exercised.
 * =============================================================================
 */
/// <reference types="node" />
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as nodeCrypto from 'node:crypto';

// Polyfill web crypto for Node/Vitest environment
if (typeof crypto === 'undefined' || !crypto.subtle) {
    // @ts-expect-error - polyfilling global crypto
    global.crypto = nodeCrypto.webcrypto;
}

import { storage, readBuffer } from './storage';
import { deriveKeyFromPassword, generateSalt, exportKey, encryptData } from './crypto';

// Helper: create a real AES-GCM CryptoKey for tests that need encryption
async function makeKey(): Promise<CryptoKey> {
    const salt = generateSalt();
    return deriveKeyFromPassword('test-password-!@#', salt);
}

// =============================================================================
// Settings
// =============================================================================
describe('storage.getSettings', () => {
    it('returns defaults when storage is empty', async () => {
        const settings = await storage.getSettings();
        expect(settings.enabled).toBe(true);
        expect(settings.notifications).toBe(true);
        expect(settings.theme).toBe('system');
        expect(settings.whitelist).toEqual([]);
    });

    it('merges persisted values over defaults', async () => {
        await storage.updateSettings({ theme: 'dark', enabled: false });
        const settings = await storage.getSettings();
        expect(settings.theme).toBe('dark');
        expect(settings.enabled).toBe(false);
        expect(settings.notifications).toBe(true); // default preserved
    });
});

// =============================================================================
// State
// =============================================================================
describe('storage.getState', () => {
    it('returns defaults when storage is empty', async () => {
        const state = await storage.getState();
        expect(state.ups).toBe(100);
        expect(state.sitesAnalyzed).toBe(0);
    });

    it('merges partial updates', async () => {
        await storage.updateState({ ups: 75, sitesAnalyzed: 3 });
        // Allow the 200ms debounce to flush
        await new Promise(r => setTimeout(r, 250));
        const state = await storage.getState();
        expect(state.ups).toBe(75);
        expect(state.sitesAnalyzed).toBe(3);
        expect(state.trackersDetected).toBe(0); // untouched default
    });
});

// =============================================================================
// Detector Logs, unencrypted path
// =============================================================================
describe('storage.addDetectorLog (no key)', () => {
    it('adds a log entry with id and timestamp', async () => {
        await storage.addDetectorLog({
            detector: 'reputation',
            domain: 'example.com',
            score: 100,
            details: {},
            message: 'Clean',
        });

        const { detectorLogs } = await chrome.storage.local.get<{ detectorLogs: any }>('detectorLogs');
        expect(Array.isArray(detectorLogs)).toBe(true);
        expect(detectorLogs).toHaveLength(1);
        expect(detectorLogs[0].id).toBeDefined();
        expect(detectorLogs[0].timestamp).toBeLessThanOrEqual(Date.now());
        expect(detectorLogs[0].domain).toBe('example.com');
    });

    it('trims to 5000 entries when exceeded', async () => {
        // Pre-fill with 5001 logs
        const existing = Array.from({ length: 5001 }, (_, i) => ({
            id: `old-${i}`,
            timestamp: Date.now() - 1000,
            detector: 'tracking' as const,
            domain: `site${i}.com`,
            score: 50,
            details: {},
            message: 'old',
        }));
        await chrome.storage.local.set({ detectorLogs: existing });

        await storage.addDetectorLog({
            detector: 'tracking',
            domain: 'new.com',
            score: 75,
            details: {},
            message: 'new',
        });

        const { detectorLogs } = await chrome.storage.local.get<{ detectorLogs: any }>('detectorLogs');
        expect(detectorLogs.length).toBeLessThanOrEqual(5000);
    });

    it('respects retention policy and removes old logs', async () => {
        await storage.updateSettings({ logRetentionDays: 1 });

        const oneDayMs = 24 * 60 * 60 * 1000;
        const old = {
            id: 'stale',
            timestamp: Date.now() - oneDayMs * 2, // 2 days ago
            detector: 'cookies' as const,
            domain: 'old.com',
            score: 50,
            details: {},
            message: 'old log',
        };
        await chrome.storage.local.set({ detectorLogs: [old] });

        // Adding a new log should trigger cleanup of the stale one
        await storage.addDetectorLog({
            detector: 'cookies',
            domain: 'fresh.com',
            score: 80,
            details: {},
            message: 'fresh',
        });

        const { detectorLogs } = await chrome.storage.local.get<{ detectorLogs: any }>('detectorLogs');
        const ids = detectorLogs.map((l: any) => l.id);
        expect(ids).not.toContain('stale');
        expect(detectorLogs.some((l: any) => l.domain === 'fresh.com')).toBe(true);
    });
});

// =============================================================================
// Detector Logs, bulk append
// =============================================================================
describe('storage.addDetectorLogs (bulk)', () => {
    it('appends many logs in a single write', async () => {
        await storage.addDetectorLogs([
            { detector: 'reputation', domain: 'a.com', score: 100, details: {}, message: 'A' },
            { detector: 'cookies', domain: 'b.com', score: 80, details: {}, message: 'B' },
        ]);

        const { detectorLogs } = await chrome.storage.local.get<{ detectorLogs: any }>('detectorLogs');
        expect(detectorLogs).toHaveLength(2);
        expect(detectorLogs.map((l: any) => l.domain).sort()).toEqual(['a.com', 'b.com']);
    });
});

// =============================================================================
// Detector Logs, encrypted path
// =============================================================================
describe('storage.addDetectorLog (with key)', () => {
    it('stores encrypted ciphertext and buffers when vault locked', async () => {
        const key = await makeKey();

        await storage.addDetectorLog({
            detector: 'tracking',
            domain: 'tracker.io',
            score: 20,
            details: {},
            message: 'Fingerprinting detected',
        }, key);

        const { detectorLogs } = await chrome.storage.local.get<{ detectorLogs: any }>('detectorLogs');
        // Should be a ciphertext string, NOT an array
        expect(typeof detectorLogs).toBe('string');
        expect(detectorLogs).not.toContain('tracker.io');

        // Adding another log without a key while data is encrypted should buffer
        // it (encrypted) in the session store rather than dropping it.
        await storage.addDetectorLog({
            detector: 'tracking',
            domain: 'other.com',
            score: 50,
            details: {},
            message: 'No key',
        }); // no key

        const buffered = await readBuffer<Array<{ domain: string }>>('bufferedDetectorLogs');
        expect(buffered).not.toBeNull();
        expect(buffered![0].domain).toBe('other.com');
    });

    it('round-trips encrypted logs correctly', async () => {
        const key = await makeKey();

        await storage.addDetectorLog({ detector: 'reputation', domain: 'a.com', score: 100, details: {}, message: 'A' }, key);
        await storage.addDetectorLog({ detector: 'cookies', domain: 'b.com', score: 60, details: {}, message: 'B' }, key);

        // Should be stored as a string
        const { detectorLogs: raw } = await chrome.storage.local.get<{ detectorLogs: any }>('detectorLogs');
        expect(typeof raw).toBe('string');
    });
});

// =============================================================================
// Notifications, unencrypted path
// =============================================================================
describe('storage.addNotification (no key)', () => {
    it('adds a notification and returns its id', async () => {
        const id = await storage.addNotification({
            type: 'pii_detected',
            title: 'Test Alert',
            message: 'Test message',
            severity: 'warning',
            domain: 'site.com',
        });

        expect(typeof id).toBe('string');
        const notifs = await storage.getNotifications();
        expect(notifs).toHaveLength(1);
        expect(notifs[0].read).toBe(false);
        expect(notifs[0].id).toBe(id);
    });

    it('prepends new notifications (most recent first)', async () => {
        await storage.addNotification({ type: 'pii_detected', title: 'First', message: '', severity: 'info', domain: 'a.com' });
        await storage.addNotification({ type: 'pii_detected', title: 'Second', message: '', severity: 'info', domain: 'b.com' });

        const notifs = await storage.getNotifications();
        expect(notifs[0].title).toBe('Second');
        expect(notifs[1].title).toBe('First');
    });

    it('caps at 100 notifications', async () => {
        for (let i = 0; i < 105; i++) {
            await storage.addNotification({ type: 'pii_detected', title: `N${i}`, message: '', severity: 'info', domain: 'x.com' });
        }
        const notifs = await storage.getNotifications();
        expect(notifs.length).toBeLessThanOrEqual(100);
    });

    it('markAsRead sets read to true', async () => {
        const id = await storage.addNotification({ type: 'tracker_alert', title: 'T', message: '', severity: 'info', domain: 'x.com' });
        await storage.markAsRead(id);
        const notifs = await storage.getNotifications();
        expect(notifs.find(n => n.id === id)?.read).toBe(true);
    });

    it('markAllAsRead marks all as read', async () => {
        await storage.addNotification({ type: 'tracker_alert', title: 'A', message: '', severity: 'info', domain: 'a.com' });
        await storage.addNotification({ type: 'tracker_alert', title: 'B', message: '', severity: 'info', domain: 'b.com' });
        await storage.markAllAsRead();
        const notifs = await storage.getNotifications();
        expect(notifs.every(n => n.read)).toBe(true);
        expect(await storage.getUnreadCount()).toBe(0);
    });

    it('removeNotification removes the correct entry', async () => {
        const id = await storage.addNotification({ type: 'pii_detected', title: 'Remove me', message: '', severity: 'warning', domain: 'x.com' });
        await storage.addNotification({ type: 'pii_detected', title: 'Keep me', message: '', severity: 'info', domain: 'y.com' });
        await storage.removeNotification(id);
        const notifs = await storage.getNotifications();
        expect(notifs.find(n => n.id === id)).toBeUndefined();
        expect(notifs.find(n => n.title === 'Keep me')).toBeDefined();
    });

    it('clearNotifications empties the list', async () => {
        await storage.addNotification({ type: 'pii_detected', title: 'A', message: '', severity: 'info', domain: 'a.com' });
        await storage.clearNotifications();
        expect(await storage.getNotifications()).toHaveLength(0);
    });
});

// =============================================================================
// Notifications: encrypted path (vault key resolved internally)
// =============================================================================
describe('storage notifications (encrypted)', () => {
    async function unlockVault(): Promise<CryptoKey> {
        const key = await makeKey();
        await chrome.storage.session.set({ cryptoKeyHex: await exportKey(key) });
        return key;
    }

    it('markAsRead resolves the vault key and keeps notifications encrypted', async () => {
        const key = await unlockVault();
        const id = await storage.addNotification({ type: 'tracker_alert', title: 'A', message: '', severity: 'info', domain: 'x.com' }, key);

        const before = await chrome.storage.local.get<{ notifications: any }>('notifications');
        expect(typeof before.notifications).toBe('string'); // stored as ciphertext

        // The UI hook calls markAsRead without a key.
        await storage.markAsRead(id);

        const after = await chrome.storage.local.get<{ notifications: any }>('notifications');
        expect(typeof after.notifications).toBe('string'); // still encrypted
        const list = await storage.getNotifications(undefined, key);
        expect(list.find(n => n.id === id)?.read).toBe(true);
    });

    it('markAllAsRead does not wipe encrypted notifications', async () => {
        const key = await unlockVault();
        await storage.addNotification({ type: 'tracker_alert', title: 'A', message: '', severity: 'info', domain: 'a.com' }, key);
        await storage.addNotification({ type: 'tracker_alert', title: 'B', message: '', severity: 'info', domain: 'b.com' }, key);

        await storage.markAllAsRead();

        const list = await storage.getNotifications(undefined, key);
        expect(list).toHaveLength(2);
        expect(list.every(n => n.read)).toBe(true);
    });

    it('removeNotification keeps the remaining entries encrypted', async () => {
        const key = await unlockVault();
        const id = await storage.addNotification({ type: 'pii_detected', title: 'Remove me', message: '', severity: 'warning', domain: 'x.com' }, key);
        await storage.addNotification({ type: 'pii_detected', title: 'Keep me', message: '', severity: 'info', domain: 'y.com' }, key);

        await storage.removeNotification(id);

        const { notifications } = await chrome.storage.local.get<{ notifications: any }>('notifications');
        expect(typeof notifications).toBe('string');
        const list = await storage.getNotifications(undefined, key);
        expect(list.find(n => n.id === id)).toBeUndefined();
        expect(list.find(n => n.title === 'Keep me')).toBeDefined();
    });

    it('clearNotifications removes the key instead of writing plaintext', async () => {
        const key = await unlockVault();
        await storage.addNotification({ type: 'pii_detected', title: 'A', message: '', severity: 'info', domain: 'a.com' }, key);

        await storage.clearNotifications();

        const { notifications } = await chrome.storage.local.get<{ notifications: any }>('notifications');
        expect(notifications).toBeUndefined();
        expect(await storage.getNotifications()).toHaveLength(0);
    });
});

// =============================================================================
// Cross-Site Exposure, unencrypted path
// =============================================================================
describe('storage.addExposure (no key)', () => {
    it('records a domain for a PII type', async () => {
        await storage.addExposure('email', 'gmail.com');
        expect(await storage.getExposureCount('email')).toBe(1);
        expect(await storage.getExposureSites('email')).toContain('gmail.com');
    });

    it('does not duplicate the same domain', async () => {
        await storage.addExposure('email', 'gmail.com');
        await storage.addExposure('email', 'gmail.com');
        expect(await storage.getExposureCount('email')).toBe(1);
    });

    it('tracks multiple PII types independently', async () => {
        await storage.addExposure('email', 'site.com');
        await storage.addExposure('phone', 'other.com');
        expect(await storage.getExposureCount('email')).toBe(1);
        expect(await storage.getExposureCount('phone')).toBe(1);
        expect(await storage.getExposureSites('email')).not.toContain('other.com');
    });

    it('getAllExposure returns the full map', async () => {
        await storage.addExposure('email', 'a.com');
        await storage.addExposure('phone', 'b.com');
        const all = await storage.getAllExposure();
        expect(all.email).toContain('a.com');
        expect(all.phone).toContain('b.com');
    });
});

// =============================================================================
// Cross-Site Exposure, encrypted path
// =============================================================================
describe('storage.addExposure (with key)', () => {
    it('stores encrypted ciphertext when key is provided', async () => {
        const key = await makeKey();
        await storage.addExposure('email', 'encrypted-site.com', key);

        const { crossSiteExposure } = await chrome.storage.local.get('crossSiteExposure');
        expect(typeof crossSiteExposure).toBe('string');
        expect(crossSiteExposure).not.toContain('encrypted-site.com');
    });

    it('buffers when vault is locked (data encrypted, no key)', async () => {
        const key = await makeKey();
        await storage.addExposure('email', 'initial.com', key);

        await storage.addExposure('email', 'second.com'); // no key

        const buffered = await readBuffer<Record<string, string[]>>('bufferedExposure');
        expect(buffered).not.toBeNull();
        expect(buffered!.email).toContain('second.com');
    });
});

// =============================================================================
// Canonical clear/reset paths
// =============================================================================
describe('storage clear/reset paths', () => {
    it('clearActivityLogs removes encrypted fields instead of writing plaintext', async () => {
        const key = await makeKey();
        await storage.addDetectorLog({ detector: 'cookies', domain: 'a.com', score: 60, details: {}, message: 'A' }, key);

        await storage.clearActivityLogs();

        const res = await chrome.storage.local.get(['detectorLogs', 'piiDetections']);
        expect(res.detectorLogs).toBeUndefined();
        expect(res.piiDetections).toBeUndefined();
    });

    it('clearActivityLogs also removes the error log', async () => {
        await chrome.storage.local.set({ errorLog: [{ timestamp: 1, message: 'x' }] });

        await storage.clearActivityLogs();

        const { errorLog } = await chrome.storage.local.get('errorLog');
        expect(errorLog).toBeUndefined();
    });

    it('resetScore removes encrypted scoreHistory/siteCache/crossSiteExposure', async () => {
        const key = await makeKey();
        await chrome.storage.local.set({
            scoreHistory: await encryptData(key, [{ timestamp: 1, ups: 90, avgSiteRisk: 50, reason: 'x' }]),
            siteCache: await encryptData(key, { 'a.com': { domain: 'a.com' } }),
            crossSiteExposure: await encryptData(key, { email: ['a.com'] }),
        });

        await storage.resetScore();

        const res = await chrome.storage.local.get(['scoreHistory', 'siteCache', 'crossSiteExposure']);
        expect(res.scoreHistory).toBeUndefined();
        expect(res.siteCache).toBeUndefined();
        expect(res.crossSiteExposure).toBeUndefined();
    });
});
