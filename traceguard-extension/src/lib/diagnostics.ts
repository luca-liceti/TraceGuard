/**
 * =============================================================================
 * DIAGNOSTICS - One structured event stream for the whole extension
 * =============================================================================
 *
 * WHY THIS EXISTS:
 * Before this module, failures disappeared. There were no global error
 * handlers anywhere in the extension, roughly sixty `catch` blocks across the
 * codebase reported to nothing, and `recordError` had a dozen call sites, all
 * of them in the background worker. A detector that threw looked exactly like
 * a clean site.
 *
 * WHAT IT DOES:
 * Every context (background service worker, content script, popup, side panel,
 * dashboard) feeds the same pipeline through `logEvent` and `captureError`.
 * Uncaught errors and unhandled promise rejections are captured by
 * `installGlobalErrorHandlers`, so a failure that nobody wrote a `catch` for is
 * still recorded.
 *
 * TWO TIERS OF PERSISTENCE:
 * - Errors always land in `errorLog` in `chrome.storage.local` (unchanged
 *   behavior, still shown in Settings, Diagnostics, capped at 100 entries).
 * - Verbose events (debug and info) are only retained when developer mode is
 *   on. When it is on, the full event stream is mirrored into
 *   `chrome.storage.session`, so the dashboard can show what the service
 *   worker saw, and everything is wiped when the browser closes. It is never
 *   written to disk and never synced.
 *
 * USAGE:
 * ```ts
 * installGlobalErrorHandlers();                      // once per context
 * setDiagnosticContext('sidepanel');                 // label this context
 * setDevMode(settings.devMode === true);             // sync from settings
 * logEvent('detector', 'warn', 'cookie_detector_failed', 'Cookie scan threw');
 * captureError('content', error, 'page_analysis_failed');
 * ```
 * =============================================================================
 */

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

/** Which part of the extension an event came from. */
export type DiagnosticArea =
    | 'background'
    | 'content'
    | 'popup'
    | 'sidepanel'
    | 'dashboard'
    | 'storage'
    | 'detector'
    | 'enrich'
    | 'scoring'
    | 'pii'
    | 'ui'
    | 'startup';

export interface DiagnosticEvent {
    /** Unique id, used to merge events written by different contexts. */
    id: string;
    timestamp: number;
    level: DiagnosticLevel;
    area: DiagnosticArea;
    /** Short, stable event name, e.g. "page_analysis_failed". */
    event: string;
    /** Human readable one-liner. */
    message: string;
    /** Structured payload. Keep it small and free of user-entered values. */
    data?: Record<string, unknown>;
}

/** Persisted in `chrome.storage.local` under `errorLog` (unchanged shape). */
export interface ErrorLogEntry {
    timestamp: number;
    message: string;
    context?: string;
}

const ERROR_LOG_KEY = 'errorLog';
const SESSION_EVENTS_KEY = 'diagnosticEvents'; // chrome.storage.session only
const ERROR_LOG_LIMIT = 100;
const MAX_EVENTS = 500;
const PERSIST_DEBOUNCE_MS = 500;
const MAX_REPORT_CHARS = 180_000;
const MAX_FIELD_CHARS = 400;

// -----------------------------------------------------------------------------
// Module state. Deliberately created without touching any chrome API so that
// importing this module is safe in tests and in contexts with no chrome object.
// -----------------------------------------------------------------------------

let devMode = false;
let events: DiagnosticEvent[] = [];
let handlersInstalled = false;
// Which context this instance of the module lives in. Every context installs
// the global handlers, so an uncaught error has to say where it came from.
let diagnosticContext: DiagnosticArea = 'ui';
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(events: DiagnosticEvent[]) => void>();

// Kept so the handlers can be detached again (used by tests, and required for
// idempotent installation in a context that re-evaluates this module).
let installedTarget: { addEventListener?: (...args: any[]) => void; removeEventListener?: (...args: any[]) => void } | null = null;
let installedHandlers: { error: (event: any) => void; rejection: (event: any) => void } | null = null;

function sessionArea(): chrome.storage.StorageArea | null {
    try {
        if (typeof chrome === 'undefined') return null;
        return chrome.storage?.session ?? null;
    } catch {
        return null;
    }
}

function localArea(): chrome.storage.StorageArea | null {
    try {
        if (typeof chrome === 'undefined') return null;
        return chrome.storage?.local ?? null;
    } catch {
        return null;
    }
}

function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Trims a value so a single field can never blow up the exported report. */
function clip(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}...` : value;
    }
    return value;
}

function clipData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!data) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) out[key] = clip(value);
    return out;
}

function notify(): void {
    const snapshot = events.slice();
    for (const listener of listeners) {
        try {
            listener(snapshot);
        } catch {
            // A broken listener must never break diagnostics.
        }
    }
}

// -----------------------------------------------------------------------------
// Context label
// -----------------------------------------------------------------------------

/**
 * Labels this context so events written by the global handlers can be traced
 * back to the popup, the dashboard, a content script, or the worker. Without
 * it, a content-script crash and a dashboard crash both read as "ui".
 */
export function setDiagnosticContext(area: DiagnosticArea): void {
    diagnosticContext = area;
}

export function getDiagnosticContext(): DiagnosticArea {
    return diagnosticContext;
}

// -----------------------------------------------------------------------------
// Developer mode
// -----------------------------------------------------------------------------

/**
 * Turns verbose capture on or off. Called from every context once settings are
 * available. Verbose events are only kept while this is on.
 */
export function setDevMode(enabled: boolean): void {
    if (devMode === enabled) return;
    devMode = enabled;
    if (enabled) {
        // Re-read anything another context already wrote, then announce itself.
        void refreshSessionEvents();
        logEvent(diagnosticContext, 'info', 'dev_mode_enabled', 'Developer mode enabled', {
            context: diagnosticContext,
        });
    }
}

export function isDevMode(): boolean {
    return devMode;
}

// -----------------------------------------------------------------------------
// Event capture
// -----------------------------------------------------------------------------

/**
 * Records a structured event. `debug` and `info` are dropped unless developer
 * mode is on; `warn` and `error` are always kept in memory.
 */
export function logEvent(
    area: DiagnosticArea,
    level: DiagnosticLevel,
    event: string,
    message: string,
    data?: Record<string, unknown>
): void {
    if ((level === 'debug' || level === 'info') && !devMode) return;

    const entry: DiagnosticEvent = {
        id: newId(),
        timestamp: Date.now(),
        level,
        area,
        event,
        message,
        data: clipData(data),
    };

    events.push(entry);
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    notify();

    // Mirror into session storage only in developer mode. Errors are already
    // durable through the error log, so this never loses the important ones.
    if (devMode) schedulePersist();
}

/** Normalizes anything thrown into a message plus a stack. */
export function normalizeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
        return { message: `${error.name}: ${error.message}`, stack: error.stack };
    }
    if (typeof error === 'string') return { message: error };
    if (error && typeof error === 'object') {
        try {
            return { message: JSON.stringify(error) };
        } catch {
            return { message: Object.prototype.toString.call(error) };
        }
    }
    return { message: String(error) };
}

/**
 * Records a failure. Always writes to the durable error log and keeps the
 * event in memory, regardless of developer mode.
 */
export function captureError(
    area: DiagnosticArea,
    error: unknown,
    event = 'error',
    data?: Record<string, unknown>
): void {
    const { message, stack } = normalizeError(error);
    logEvent(area, 'error', event, message, { ...data, ...(stack ? { stack } : {}) });
    const context = stack ?? (data ? JSON.stringify(clipData(data)) : undefined);
    void queueErrorWrite(() => appendErrorLog(message, context));
}

/**
 * Serializes error-log writes. Without this, a capture that is fired and
 * forgotten can land after a clear, and the log briefly loses ordering.
 */
let errorWriteChain: Promise<void> = Promise.resolve();
function queueErrorWrite(task: () => Promise<void>): Promise<void> {
    const next = errorWriteChain.then(task, task);
    // Keep the chain alive even if one write fails.
    errorWriteChain = next.catch(() => {});
    return next;
}

/**
 * Resolves once every captured error has been written and any pending session
 * mirror has been flushed. Call this before reading or exporting the log.
 */
export async function flushDiagnostics(): Promise<void> {
    await errorWriteChain;
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
        await persistSessionEvents();
    }
}

async function appendErrorLog(message: string, context?: string): Promise<void> {
    const area = localArea();
    if (!area) return;
    try {
        const result = await area.get(ERROR_LOG_KEY);
        const existing: ErrorLogEntry[] = Array.isArray(result[ERROR_LOG_KEY]) ? result[ERROR_LOG_KEY] : [];
        const entry: ErrorLogEntry = { timestamp: Date.now(), message, context };
        await area.set({ [ERROR_LOG_KEY]: [...existing, entry].slice(-ERROR_LOG_LIMIT) });
    } catch {
        // Error logging must never throw or recurse.
    }
}

// -----------------------------------------------------------------------------
// Session buffer (developer mode)
// -----------------------------------------------------------------------------

function schedulePersist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void persistSessionEvents();
    }, PERSIST_DEBOUNCE_MS);
}

async function persistSessionEvents(): Promise<void> {
    const area = sessionArea();
    if (!area) return;
    try {
        const stored = await readStoredEvents(area);
        const merged = mergeEvents(stored, events);
        await area.set({ [SESSION_EVENTS_KEY]: merged });
    } catch {
        // Session storage is best effort; never surface this as a failure.
    }
}

async function readStoredEvents(area: chrome.storage.StorageArea): Promise<DiagnosticEvent[]> {
    try {
        const result = await area.get(SESSION_EVENTS_KEY);
        const raw = result[SESSION_EVENTS_KEY];
        return Array.isArray(raw) ? (raw as DiagnosticEvent[]) : [];
    } catch {
        return [];
    }
}

/** Merges two event lists by id, oldest first, capped at MAX_EVENTS. */
function mergeEvents(a: DiagnosticEvent[], b: DiagnosticEvent[]): DiagnosticEvent[] {
    const byId = new Map<string, DiagnosticEvent>();
    for (const entry of a) byId.set(entry.id, entry);
    for (const entry of b) byId.set(entry.id, entry);
    return Array.from(byId.values())
        .sort((x, y) => x.timestamp - y.timestamp)
        .slice(-MAX_EVENTS);
}

/**
 * Pulls the shared session log into memory. Called on startup and whenever
 * developer mode turns on, so the dashboard sees events written by the service
 * worker and the content script.
 */
export async function refreshSessionEvents(): Promise<DiagnosticEvent[]> {
    const area = sessionArea();
    if (!area) return events.slice();
    const stored = await readStoredEvents(area);
    events = mergeEvents(stored, events);
    notify();
    return events.slice();
}

/** In-memory events, oldest first. */
export function getSessionEvents(): DiagnosticEvent[] {
    return events.slice();
}

/** Subscribes to new events. Returns an unsubscribe function. */
export function subscribeEvents(listener: (events: DiagnosticEvent[]) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Clears the in-memory session log and the shared session buffer. */
export async function clearSessionEvents(): Promise<void> {
    events = [];
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    const area = sessionArea();
    if (area) {
        try {
            await area.remove(SESSION_EVENTS_KEY);
        } catch {
            // Best effort.
        }
    }
    notify();
}

// -----------------------------------------------------------------------------
// Error log (durable, unchanged public contract)
// -----------------------------------------------------------------------------

/**
 * Appends an entry to the durable error log and records it as an error event.
 * Preserved signature so existing call sites and the Settings panel keep working.
 */
export async function recordError(
    message: string,
    context?: string,
    area: DiagnosticArea = 'background'
): Promise<void> {
    logEvent(area, 'error', 'recorded_error', message, context ? { context } : undefined);
    await queueErrorWrite(() => appendErrorLog(message, context));
}

/** Returns the recorded errors, oldest first. */
export async function getErrorLog(): Promise<ErrorLogEntry[]> {
    const area = localArea();
    if (!area) return [];
    const result = await area.get(ERROR_LOG_KEY);
    return Array.isArray(result[ERROR_LOG_KEY]) ? result[ERROR_LOG_KEY] : [];
}

/** Clears the durable error log and the session log. */
export async function clearErrorLog(): Promise<void> {
    // Queued behind any pending append so a just-captured error cannot land
    // after the clear and reappear.
    await queueErrorWrite(async () => {
        const area = localArea();
        if (!area) return;
        try {
            await area.remove(ERROR_LOG_KEY);
        } catch {
            // Best effort.
        }
    });
    await clearSessionEvents();
}

// -----------------------------------------------------------------------------
// Global handlers
// -----------------------------------------------------------------------------

/**
 * Browser-generated `error` events that are not failures.
 *
 * The first real diagnostics bundle exported from a 1.5.0 install contained
 * exactly one "error", `ResizeObserver loop completed with undelivered
 * notifications.`, which Chrome fires as a window `error` event on any layout
 * with a ResizeObserver. Nothing is broken, but it lands in the durable error
 * log (capped at 100 entries) and crowds out real crashes. These are recorded
 * at debug instead, so developer mode can still prove they happened while the
 * durable log stays meaningful.
 */
const BENIGN_ERROR_PATTERNS: RegExp[] = [
    /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/,
];

function isBenignBrowserNoise(message: string): boolean {
    return BENIGN_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Installs `error` and `unhandledrejection` handlers on the current global.
 * Works in both the service worker and page contexts: the handler is attached
 * to `globalThis`, and a module-level flag keeps double installation harmless.
 */
export function installGlobalErrorHandlers(): void {
    if (handlersInstalled) return;
    handlersInstalled = true;

    const target = globalThis as unknown as {
        addEventListener?: (type: string, listener: (event: any) => void) => void;
        removeEventListener?: (type: string, listener: (event: any) => void) => void;
    };
    if (typeof target.addEventListener !== 'function') return;

    const onError = (event: any) => {
        // Resource load errors (img/script 404s) have no `error` object and are
        // not actionable here, so only capture real script errors.
        const error = event?.error;
        if (!error && !event?.message) return;
        const location = {
            source: event?.filename,
            line: event?.lineno,
            column: event?.colno,
        };
        // Keep the durable error log free of browser noise that is not a failure.
        if (!error && typeof event?.message === 'string' && isBenignBrowserNoise(event.message)) {
            logEvent(diagnosticContext, 'debug', 'benign_browser_noise', event.message, location);
            return;
        }
        captureError(diagnosticContext, error ?? event.message, 'uncaught_error', location);
    };

    const onRejection = (event: any) => {
        captureError(diagnosticContext, event?.reason ?? 'Unhandled promise rejection', 'unhandled_rejection');
    };

    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    installedTarget = target;
    installedHandlers = { error: onError, rejection: onRejection };
}

// -----------------------------------------------------------------------------
// Export bundle (one click to copy, ready to paste into a bug report)
// -----------------------------------------------------------------------------

function describeEnvironment(): Record<string, string> {
    const info: Record<string, string> = {
        generated: new Date().toISOString(),
        'developer mode': devMode ? 'on' : 'off',
        browser: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    };
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
            const manifest = chrome.runtime.getManifest();
            if (manifest.version) info.version = manifest.version;
            if (manifest.name) info.name = manifest.name;
        }
    } catch {
        // Manifest access can fail in tests; the rest of the report still works.
    }
    return info;
}

function formatEvent(event: DiagnosticEvent): string {
    const time = new Date(event.timestamp).toISOString().slice(11, 23);
    const level = event.level.toUpperCase().padEnd(5);
    const data = event.data ? ` ${JSON.stringify(event.data)}` : '';
    return `- ${time} [${level}] ${event.area}/${event.event}: ${event.message}${data}`;
}

/**
 * Builds the markdown bundle copied by "Copy diagnostics": environment header,
 * recorded errors first (highest signal), then the chronological timeline.
 */
export function formatDiagnosticsReport(): string {
    const env = describeEnvironment();
    const errors = events.filter(entry => entry.level === 'error');
    const lines: string[] = [
        '# TraceGuard diagnostics',
        '',
        ...Object.entries(env).map(([key, value]) => `- ${key}: ${value}`),
        '',
        `## Errors (${errors.length})`,
        '',
    ];

    if (errors.length === 0) {
        lines.push('None recorded in this session.', '');
    } else {
        for (const entry of errors) {
            lines.push(
                `### ${new Date(entry.timestamp).toISOString()} | ${entry.area} | ${entry.event}`,
                entry.message,
                entry.data?.stack ? `\n\`\`\`\n${entry.data.stack}\n\`\`\`` : '',
                ''
            );
        }
    }

    lines.push(`## Timeline (${events.length} events)`, '');
    if (events.length === 0) {
        lines.push('No events recorded. Turn on Developer mode to capture verbose diagnostics.');
    } else {
        for (const entry of events) lines.push(formatEvent(entry));
    }

    const report = lines.filter(line => line !== undefined).join('\n');
    return report.length > MAX_REPORT_CHARS
        ? `${report.slice(0, MAX_REPORT_CHARS)}\n\n[truncated]`
        : report;
}

/**
 * Copies the diagnostics bundle to the clipboard. Returns the text and whether
 * the clipboard write succeeded, so the caller can fall back to showing it.
 */
export async function copyDiagnosticsToClipboard(): Promise<{ text: string; copied: boolean }> {
    // Make sure errors captured a moment ago are in the bundle, not in flight.
    await flushDiagnostics();
    await refreshSessionEvents();
    const text = formatDiagnosticsReport();
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return { text, copied: true };
        }
    } catch {
        // Clipboard permissions vary; the caller falls back to a download.
    }
    return { text, copied: false };
}

/** Test helper: wipes in-memory state so a suite starts clean. */
export function __resetDiagnosticsForTests(): void {
    if (installedTarget?.removeEventListener && installedHandlers) {
        installedTarget.removeEventListener('error', installedHandlers.error);
        installedTarget.removeEventListener('unhandledrejection', installedHandlers.rejection);
    }
    installedTarget = null;
    installedHandlers = null;
    events = [];
    devMode = false;
    handlersInstalled = false;
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    listeners.clear();
}
