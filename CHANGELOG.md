# Changelog

Each release ships with **What's new** and/or **What was fixed** describing user-facing changes. The release workflow pulls the top section of this file into the GitHub release body.

## v1.5.0

**What's new**

- Developer mode (Settings, About): a verbose on-device diagnostics log. Turn it on while troubleshooting, then click "Copy diagnostics" to copy a ready-to-paste bundle containing your extension version, browser, every recorded error, and the full event timeline. It is off by default, stays on your device, and is cleared when you close the browser.
- The extension now catches errors that no code path handled. Uncaught errors and unhandled promise rejections are recorded in the background worker, the content script, the popup, the side panel, and the dashboard, so failures surface in the diagnostics bundle instead of disappearing.

**What was fixed**

- Failures that used to vanish silently now leave a trace: detector errors, storage quota exhaustion, page-analysis delivery failures, and first-run check failures are all recorded.
- A thrown error inside the cookie detector no longer looks identical to a clean page in the diagnostics log.
- React crash screens now record the component stack alongside the error.
- Removed the last stray `console.log` from the policy detector.

## v1.4.3

**What's new**

- First click of the extension icon on a fresh install now opens the dashboard's vault-creation page (in both popup and side-panel mode) instead of squeezing account setup into the popup.
- The dashboard sidebar automatically collapses to icons when the window gets too small and expands again when it returns to a normal size.
- Personal-data penalties on risky sites are now gated behind the "Is this website safe?" confirmation card — confirming vouchsafes the site and waives the penalty for that visit.
- The dashboard now recovers automatically after an extension update instead of showing a crash screen when a stale page chunk can no longer be loaded.

**What was fixed**

- Score graph: the 7-day and 30-day tabs now plot each day's closing score (the real trajectory) instead of an average, with a larger history so those tabs show actual data; the donut's up/down delta now matches the chart, and a proper loading state replaced the "No data yet" flash.
- Fixed false-positive personal-data detection: German "ein" fields no longer count as SSNs, and "unit" quantity fields no longer count as addresses.
- Fixed score corruption when a user's score is 0 — penalties and recoveries no longer compute from a baseline of 100.
- Cookie and tracker detection no longer flags lookalikes via substring matches (e.g. `refresh` containing Facebook's `fr` cookie, `notfacebook.com` containing "facebook"), and generic CDNs (CloudFront, S3, etc.) are no longer counted as trackers.
- Overview site logs now show sensitive fields that appeared after the initial page analysis.
- The README badge now links to the live Chrome Web Store listing.

## v1.4.2

**What's new**

- Restored the README screenshots in a tracked `screenshots/` folder after untracking the `docs/` directory.
- Releases now ship with curated "What's new / What was fixed" notes (changelog-driven).

**What was fixed**

- Full ToS;DR privacy-policy catalog (412 graded domains, up from 66) with point-by-point details and document links.
- "Enhanced Policy Analysis" renamed to **Live rating updates**.
- Vault auto-lock now actually re-locks the UI after the timeout.
- PII penalties resolve the correct site's reputation instead of the active tab.
- Locked-vault buffer moved to session storage, matching the privacy policy.
- Same-party tracker/cookie matching no longer treats lookalike domains (e.g. `notexample.com`) as first-party.
- Tracking score computed from the bundled tracker databases.
- Eliminated lost-update races on counter increments.
- Progressive backoff on failed master-password attempts.
- Import/restore for exported backups.

## v1.4.1

**What's new**

- Production-readiness audit remediation (security, correctness, and privacy-policy alignment).
- Bundled ToS;DR catalog and cloud-toggle rename (superseded by v1.4.2 notes).

**What was fixed**

- See the v1.4.2 "What was fixed" list above.
