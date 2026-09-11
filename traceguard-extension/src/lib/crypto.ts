/**
 * =============================================================================
 * CRYPTO LAYER - Bitwarden-Style Encryption
 * =============================================================================
 * 
 * Provides AES-GCM encryption and PBKDF2 key derivation.
 * Used to lock the extension and protect sensitive telemetry.
 */

import { logEvent } from './diagnostics';

const ALGO_NAME = 'AES-GCM';
const PBKDF2_ITERATIONS = 600000;
const PBKDF2_HASH = 'SHA-256';

/**
 * Derives a 256-bit AES-GCM CryptoKey from a user password and salt.
 * 
 * Cryptography Contract (PBKDF2):
 * - Hash: SHA-256
 * - Iterations: 600,000 (OWASP recommended minimum for 2024+)
 * - Length: 256 bits
 * - Salt: 16 bytes (Cryptographically secure random)
 */
export async function deriveKeyFromPassword(password: string, salt: Uint8Array<ArrayBuffer>, extractable = true): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: PBKDF2_HASH
        },
        keyMaterial,
        { name: ALGO_NAME, length: 256 },
        extractable,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypts arbitrary data (objects, strings) using AES-GCM.
 * Returns a Base64-encoded string containing both IV and ciphertext.
 */
export async function encryptData(key: CryptoKey, data: any): Promise<string> {
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(JSON.stringify(data));
    
    // Generate a random 12-byte IV for GCM
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const ciphertextBuffer = await crypto.subtle.encrypt(
        { name: ALGO_NAME, iv: iv },
        key,
        encodedData
    );
    
    // Combine IV and ciphertext for storage
    const ciphertext = new Uint8Array(ciphertextBuffer);
    const combined = new Uint8Array(iv.length + ciphertext.length);
    combined.set(iv, 0);
    combined.set(ciphertext, iv.length);
    
    // Convert to base64
    let binary = '';
    for (let i = 0; i < combined.byteLength; i++) {
        binary += String.fromCharCode(combined[i]);
    }
    return btoa(binary);
}

/**
 * Decrypts a Base64-encoded string back to its original data.
 */
export async function decryptData<T = any>(key: CryptoKey, encryptedBase64: string): Promise<T | null> {
    try {
        const binary = atob(encryptedBase64);
        const combined = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            combined[i] = binary.charCodeAt(i);
        }
        
        // Extract IV and ciphertext
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        
        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: ALGO_NAME, iv: iv },
            key,
            ciphertext
        );
        
        const decoder = new TextDecoder();
        return JSON.parse(decoder.decode(decryptedBuffer)) as T;
    } catch (error) {
        // A failed decrypt is expected whenever the key is wrong or the blob is
        // corrupt, so it is recorded as a session warning rather than a durable
        // error. Callers that must not mistake "unreadable" for "empty" use
        // `decryptDataStrict` instead.
        logEvent('storage', 'warn', 'decryption_failed', 'Could not decrypt stored data', {
            error: String(error),
        });
        return null;
    }
}

/**
 * Sentinel returned when stored data exists but cannot be decrypted.
 *
 * `decryptData` returns `null` both when a key is absent and when decryption
 * fails. Read-modify-write paths used to treat both as empty, so a transient
 * failure rewrote an encrypted collection (site cache, score history, PII
 * journal, notifications) with only the newest entry, destroying the rest.
 */
export const DECRYPT_FAILED = Symbol('traceguard-decrypt-failed');

/**
 * Like `decryptData`, but keeps "unreadable" apart from "absent".
 *
 * Mutation paths must use this: on `DECRYPT_FAILED` the caller must skip its
 * write and report the failure rather than replace the stored blob.
 */
export async function decryptDataStrict<T = any>(
    key: CryptoKey,
    encryptedBase64: string
): Promise<T | typeof DECRYPT_FAILED> {
    const parsed = await decryptData<T>(key, encryptedBase64);
    return parsed === null ? DECRYPT_FAILED : parsed;
}

/**
 * Exports a CryptoKey to a raw hex string for storing in chrome.storage.session
 */
export async function exportKey(key: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('raw', key);
    const exportedArray = new Uint8Array(exported);
    return Array.from(exportedArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Imports a hex string key from chrome.storage.session back to a CryptoKey
 */
export async function importKey(hexStr: string): Promise<CryptoKey> {
    const raw = new Uint8Array(hexStr.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return crypto.subtle.importKey(
        'raw',
        raw,
        { name: ALGO_NAME },
        true,
        ['encrypt', 'decrypt']
    );
}

/**
 * Utility to generate a cryptographically secure random salt
 */
export function generateSalt(): Uint8Array<ArrayBuffer> {
    return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Generates a fresh 256-bit AES-GCM key (extractable, so it can be persisted
 * to chrome.storage.local for the locked-vault buffer).
 */
export async function generateAesKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
        { name: ALGO_NAME, length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
}

/**
 * Validates that a salt is properly formed and cryptographically sound
 * (Not empty, correct length, and not a static/zeroed array)
 */
export function verifySaltUniqueness(salt: Uint8Array<ArrayBuffer>): boolean {
    if (!salt || salt.length !== 16) return false;
    
    // Check if the salt is just an array of zeros (uninitialized memory)
    let isAllZeros = true;
    for (let i = 0; i < salt.length; i++) {
        if (salt[i] !== 0) {
            isAllZeros = false;
            break;
        }
    }
    
    return !isAllZeros;
}
