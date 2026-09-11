/**
 * =============================================================================
 * EXPORT, Single canonical "Export Data" path
 * =============================================================================
 *
 * Both the Settings modal and the search-command palette route through
 * `exportAllData` so they behave identically. The exported backup:
 *   - never includes the raw buffer encryption key (`bufferKeyHex`)
 *   - decrypts vault fields only when the vault is unlocked (so the backup is
 *     actually usable)
 *   - strips cookie values and request query strings as a defensive measure
 *   - can be password-protected with PBKDF2-SHA256 + AES-GCM
 *
 * The password decision and prompt live in the UI (ExportDataDialog), not here,
 * so the export never relies on browser `confirm`/`prompt` dialogs.
 * =============================================================================
 */

import { z } from 'zod';

import {
    decryptData,
    deriveKeyFromPassword,
    encryptData,
    generateSalt,
    importKey,
} from './crypto';

const PBKDF2_ITERATIONS = 600000;

// Fields that are stored AES-GCM-encrypted when the vault is unlocked.
const VAULT_FIELDS: Array<[string, 'object' | 'array']> = [
    ['siteCache', 'object'],
    ['crossSiteExposure', 'object'],
    ['scoreHistory', 'array'],
    ['piiDetections', 'array'],
    ['detectorLogs', 'array'],
    ['notifications', 'array'],
];

/**
 * Reliably saves a JSON payload to the user's machine and resolves only when
 * the browser has actually finished writing the file (or rejects when the
 * save was cancelled or interrupted). Uses the `downloads` API when available
 * so the caller never shows a false "exported" toast for a save that did not
 * happen.
 */
export async function downloadJson(json: string, filename: string): Promise<void> {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    if (typeof chrome.downloads?.download === 'function') {
        const id = await chrome.downloads.download({ url, filename, saveAs: false });
        await new Promise<void>((resolve, reject) => {
            const listener = (delta: chrome.downloads.DownloadDelta) => {
                if (delta.id !== id || !delta.state) return;
                chrome.downloads.onChanged.removeListener(listener);
                URL.revokeObjectURL(url);
                if (delta.state.current === 'complete') {
                    resolve();
                } else {
                    reject(new Error(`Download ended with state '${delta.state.current}'`));
                }
            };
            chrome.downloads.onChanged.addListener(listener);
        });
        return;
    }

    // Fallback for contexts without the downloads permission: anchor click.
    // The blob URL must outlive the save, so revoke it late instead of
    // immediately — an immediate revoke can abort a download that is waiting
    // on the OS "save as" dialog.
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function triggerDownload(json: string, passwordProtected: boolean): Promise<void> {
    await downloadJson(
        json,
        `traceguard-backup${passwordProtected ? '-encrypted' : ''}-${new Date().toISOString().split('T')[0]}.json`
    );
}

/**
 * Gathers, sanitizes, optionally encrypts, and downloads a full data backup.
 * Pass a non-empty `password` to encrypt the backup, or `null` for a plaintext
 * export. Throws on failure; the caller handles cancellation and toasts.
 */
export async function exportAllData(password: string | null): Promise<void> {
    const allData: Record<string, unknown> = await chrome.storage.local.get(null);

    // Never export the raw buffer key, it would let a reader decrypt
    // locked-vault buffered telemetry.
    delete allData.bufferKeyHex;
    delete allData.cryptoKeyHex; // defensive: should never be in local anyway

    // Decrypt vault fields (only possible while unlocked) so the backup is usable.
    const session = await chrome.storage.session.get<{ cryptoKeyHex?: string }>('cryptoKeyHex');
    if (session.cryptoKeyHex) {
        const key = await importKey(session.cryptoKeyHex);
        for (const [field, kind] of VAULT_FIELDS) {
            if (typeof allData[field] === 'string') {
                allData[field] = (await decryptData(key, allData[field] as string)) ?? (kind === 'object' ? {} : []);
            }
        }
    }

    // Defensively strip legacy cookie values / query strings.
    if (allData.siteCache && typeof allData.siteCache === 'object') {
        for (const site of Object.values(allData.siteCache as Record<string, any>)) {
            const enriched = site?.enrichedDetails;
            if (enriched?.cookies?.items) {
                for (const c of enriched.cookies.items) delete c.value;
            }
            if (enriched?.networkRequests?.items) {
                for (const r of enriched.networkRequests.items) {
                    if (typeof r.url === 'string') {
                        try {
                            const u = new URL(r.url);
                            r.url = u.origin + u.pathname;
                        } catch {
                            /* keep as-is */
                        }
                    }
                }
            }
        }
    }

    if (password) {
        const salt = generateSalt();
        const key = await deriveKeyFromPassword(password, salt);
        const payload = await encryptData(key, allData);
        const envelope = {
            format: 'traceguard-backup',
            version: 1,
            encrypted: true,
            kdf: {
                name: 'PBKDF2-SHA256',
                iterations: PBKDF2_ITERATIONS,
                salt: Array.from(salt),
            },
            payload,
        };
        await triggerDownload(JSON.stringify(envelope, null, 2), true);
    } else {
        await triggerDownload(JSON.stringify(allData, null, 2), false);
    }
}

// Fields that can be restored from a backup. Vault fields are re-encrypted
// with the current session key on import; plaintext fields are written as-is.
// Credential material (cryptoSalt, validator, bufferKeyHex, cryptoKeyHex) is
// deliberately excluded - importing it would break the current vault.
const IMPORTABLE_VAULT_KEYS = [
    'siteCache',
    'crossSiteExposure',
    'scoreHistory',
    'piiDetections',
    'detectorLogs',
    'notifications',
] as const;

/** Largest backup the importer will read into memory, in characters. */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

/**
 * A backup is user-supplied JSON, so each restorable plaintext key is validated
 * before it reaches storage. Without this a malformed file could write a
 * non-array allow list, an out-of-range threshold, or a settings object the rest
 * of the extension cannot read.
 */
const UserSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    notifications: z.boolean().optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    whitelist: z.array(z.string().min(1).max(255)).max(5000).optional(),
    blacklist: z.array(z.string().min(1).max(255)).max(5000).optional(),
    notificationLevel: z.enum(['silent', 'balanced', 'aggressive']).optional(),
    wssThreshold: z.number().finite().min(0).max(100).optional(),
    logRetentionDays: z.number().finite().min(0).max(3650).optional(),
    enablePIIDetection: z.boolean().optional(),
    displayMode: z.enum(['popup', 'sidebar']).optional(),
    autoLockTimeout: z.number().finite().min(-1).max(10080).optional(),
    databaseRefreshDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).optional(),
    enableCloudTosdr: z.boolean().optional(),
    devMode: z.boolean().optional(),
}).passthrough();

const AppStateSchema = z.object({
    ups: z.number().finite().min(0).max(100).optional(),
    sitesAnalyzed: z.number().finite().min(0).optional(),
    trackersDetected: z.number().finite().min(0).optional(),
    piiEventsCount: z.number().finite().min(0).optional(),
    safeVisitStreak: z.number().finite().min(0).optional(),
    currentSite: z.unknown().optional(),
}).passthrough();

/**
 * Restores a TraceGuard backup (plaintext or password-protected).
 *
 * Requires the vault to be unlocked so restored vault fields can be re-encrypted
 * with the current master-password key. Throws with a human-readable message on
 * malformed input, a wrong/missing password, or a locked vault.
 *
 * @returns The list of storage keys that were restored.
 */
export async function importAllData(text: string, password: string | null): Promise<string[]> {
    if (text.length > MAX_BACKUP_BYTES) {
        throw new Error('This backup is too large to import (50 MB limit).');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('This file is not valid JSON.');
    }

    let data: Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && (parsed as { format?: string }).format === 'traceguard-backup') {
        const envelope = parsed as { encrypted?: boolean; kdf?: { salt: number[] }; payload?: string };
        if (envelope.encrypted) {
            if (!password) throw new Error('This backup is password-protected. Enter its password to import.');
            if (!Array.isArray(envelope.kdf?.salt) || typeof envelope.payload !== 'string') {
                throw new Error('This backup is malformed.');
            }
            const salt = new Uint8Array(envelope.kdf.salt);
            const key = await deriveKeyFromPassword(password, salt);
            const decrypted = await decryptData(key, envelope.payload);
            if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
                throw new Error('Incorrect password, or the backup is corrupt.');
            }
            data = decrypted as Record<string, unknown>;
        } else {
            throw new Error('This backup is malformed.');
        }
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
    } else {
        throw new Error('This file is not a TraceGuard backup.');
    }

    // Validate everything before writing anything, so a bad file cannot leave a
    // half-restored backup behind.
    const vault: Array<[string, unknown]> = [];
    for (const k of IMPORTABLE_VAULT_KEYS) {
        if (!(k in data)) continue;
        const value = data[k];
        const isDomainMap = k === 'siteCache' || k === 'crossSiteExposure';
        const valid = isDomainMap
            ? typeof value === 'object' && value !== null && !Array.isArray(value)
            : Array.isArray(value);
        if (!valid) throw new Error(`This backup's "${k}" data is not valid.`);
        vault.push([k, value]);
    }

    const plain: Array<[string, unknown]> = [];
    if ('settings' in data) {
        const result = UserSettingsSchema.safeParse(data.settings);
        if (!result.success) throw new Error('This backup contains invalid settings.');
        plain.push(['settings', result.data]);
    }
    if ('state' in data) {
        const result = AppStateSchema.safeParse(data.state);
        if (!result.success) throw new Error('This backup contains an invalid app state.');
        plain.push(['state', result.data]);
    }
    if ('tosdr_cache' in data) {
        const value = data.tosdr_cache;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error('This backup contains an invalid rating cache.');
        }
        plain.push(['tosdr_cache', value]);
    }

    const session = await chrome.storage.session.get<{ cryptoKeyHex?: string }>('cryptoKeyHex');
    if (!session.cryptoKeyHex) throw new Error('Unlock your vault before importing a backup.');
    const key = await importKey(session.cryptoKeyHex);

    const restored: string[] = [];
    for (const [k, value] of vault) {
        await chrome.storage.local.set({ [k]: await encryptData(key, value) });
        restored.push(k);
    }
    for (const [k, value] of plain) {
        await chrome.storage.local.set({ [k]: value });
        restored.push(k);
    }

    return restored;
}
