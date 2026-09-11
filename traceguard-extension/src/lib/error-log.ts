/**
 * =============================================================================
 * LOCAL ERROR LOG - On-device diagnostics (zero telemetry)
 * =============================================================================
 *
 * This used to be the whole error story: a 100-entry ring buffer in
 * `chrome.storage.local` that only recorded errors someone explicitly called
 * `recordError()` on. It is now the durable half of `lib/diagnostics.ts`, which
 * also captures uncaught errors and the verbose developer-mode event stream.
 *
 * The import path and the public API are unchanged, so every existing call site
 * and the Settings, Diagnostics panel keep working. New code should prefer
 * `captureError` / `logEvent` from `lib/diagnostics` directly.
 */

export type { ErrorLogEntry } from './diagnostics';
export { recordError, getErrorLog, clearErrorLog } from './diagnostics';
