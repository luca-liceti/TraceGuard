import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    __resetDiagnosticsForTests,
    captureError,
    clearErrorLog,
    clearSessionEvents,
    copyDiagnosticsToClipboard,
    flushDiagnostics,
    formatDiagnosticsReport,
    getErrorLog,
    getSessionEvents,
    installGlobalErrorHandlers,
    isDevMode,
    logEvent,
    normalizeError,
    refreshSessionEvents,
    setDevMode,
} from './diagnostics';

/**
 * These tests exist because the extension used to have no way to see a failure
 * it had not explicitly caught. Each case below pins one part of that contract:
 * uncaught errors are captured, verbose events respect developer mode, and the
 * copied bundle carries enough context to reproduce a bug.
 */

function dispatchError(message: string) {
    window.dispatchEvent(new ErrorEvent('error', { message, error: new Error(message) }));
}

function dispatchRejection(reason: unknown) {
    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = reason;
    window.dispatchEvent(event);
}

describe('diagnostics', () => {
    beforeEach(() => {
        __resetDiagnosticsForTests();
    });

    afterEach(() => {
        __resetDiagnosticsForTests();
    });

    it('captures uncaught errors thrown on the page', () => {
        installGlobalErrorHandlers();

        dispatchError('kaboom');

        const errors = getSessionEvents().filter(entry => entry.level === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0].event).toBe('uncaught_error');
        expect(errors[0].message).toContain('kaboom');
    });

    it('captures unhandled promise rejections', () => {
        installGlobalErrorHandlers();

        dispatchRejection(new Error('rejected'));

        const errors = getSessionEvents().filter(entry => entry.event === 'unhandled_rejection');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('rejected');
    });

    it('installs the global handlers only once', () => {
        installGlobalErrorHandlers();
        installGlobalErrorHandlers();

        dispatchError('once');

        expect(getSessionEvents().filter(entry => entry.event === 'uncaught_error')).toHaveLength(1);
    });

    it('writes captured errors to the durable error log too', async () => {
        captureError('content', new Error('detector exploded'), 'cookie_detector_failed');
        await flushDiagnostics();

        const log = await getErrorLog();
        expect(log).toHaveLength(1);
        expect(log[0].message).toContain('detector exploded');
        // The stack is kept as context so the exported log is actionable.
        expect(log[0].context).toContain('diagnostics.test');
    });

    it('drops verbose events unless developer mode is on', () => {
        logEvent('background', 'debug', 'hidden', 'should not be kept');
        expect(getSessionEvents()).toHaveLength(0);

        setDevMode(true);
        logEvent('background', 'debug', 'visible', 'kept');
        expect(isDevMode()).toBe(true);
        expect(getSessionEvents().some(entry => entry.event === 'visible')).toBe(true);
    });

    it('always keeps warnings and errors regardless of developer mode', () => {
        logEvent('detector', 'warn', 'tolerated_failure', 'expected network failure');
        logEvent('storage', 'error', 'quota_exceeded', 'out of room');

        const kept = getSessionEvents();
        expect(kept).toHaveLength(2);
    });

    it('mirrors developer-mode events into session storage and reads them back', async () => {
        setDevMode(true);
        logEvent('background', 'debug', 'mirrored', 'written to session storage');
        await flushDiagnostics();
        await refreshSessionEvents();

        const stored = await chrome.storage.session.get('diagnosticEvents');
        const events = stored.diagnosticEvents as Array<{ event: string }>;
        expect(events.some(entry => entry.event === 'mirrored')).toBe(true);
    });

    it('clears both the durable error log and the session stream', async () => {
        setDevMode(true);
        captureError('ui', new Error('boom'), 'test_error');
        logEvent('ui', 'debug', 'extra', 'context');
        await flushDiagnostics();

        await clearErrorLog();

        expect(await getErrorLog()).toHaveLength(0);
        expect(getSessionEvents()).toHaveLength(0);
    });

    it('survives session storage being unavailable', async () => {
        setDevMode(true);
        // The mock always has session storage, so remove it for this case.
        const mutableStorage = chrome.storage as { session?: unknown };
        const original = mutableStorage.session;
        mutableStorage.session = undefined;
        try {
            logEvent('ui', 'debug', 'no_session_storage', 'still buffered in memory');
            await expect(refreshSessionEvents()).resolves.toBeInstanceOf(Array);
            expect(getSessionEvents().some(entry => entry.event === 'no_session_storage')).toBe(true);
        } finally {
            mutableStorage.session = original;
        }
    });

    it('formats a report with the environment, errors, and timeline', () => {
        setDevMode(true);
        captureError('background', new Error('page analysis failed'), 'page_analysis_failed');
        logEvent('background', 'debug', 'message_received', 'PAGE_ANALYSIS_RESULT');

        const report = formatDiagnosticsReport();

        expect(report).toContain('# TraceGuard diagnostics');
        expect(report).toContain('- version: 1.0.0');
        expect(report).toContain('## Errors (1)');
        expect(report).toContain('page_analysis_failed');
        expect(report).toMatch(/## Timeline \(\d+ events\)/);
        expect(report).toContain('message_received');
    });

    it('copies the report and reports whether the clipboard write worked', async () => {
        captureError('ui', new Error('copy me'), 'test_error');

        const { text, copied } = await copyDiagnosticsToClipboard();

        expect(text).toContain('copy me');
        expect(typeof copied).toBe('boolean');
    });

    it('normalizes thrown values that are not Error instances', () => {
        expect(normalizeError('plain string').message).toBe('plain string');
        expect(normalizeError({ code: 42 }).message).toBe('{"code":42}');
        expect(normalizeError(undefined).message).toBe('undefined');
    });

    it('clears the session buffer on request', async () => {
        setDevMode(true);
        logEvent('ui', 'info', 'something', 'happened');

        await clearSessionEvents();

        expect(getSessionEvents()).toHaveLength(0);
    });
});
