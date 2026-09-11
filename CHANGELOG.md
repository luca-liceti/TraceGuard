# Changelog

Each release ships with **What's new** and/or **What was fixed** describing user-facing changes. The release workflow pulls the top section of this file into the GitHub release body.

## v1.7.7

**What was fixed**

- The Privacy Score now looks the same everywhere. The dashboard ring and the side panel and popup bar are coloured by the score band (green, amber, orange, or red), and the number is a single neutral colour. Previously the panel coloured its number and left its bar neutral, while the dashboard did the opposite.
- The band is now also spelled out next to the score, so the colour is not the only thing carrying it. That matters for anyone who cannot separate amber, orange, and green.
- Light mode's score colours are slightly deeper so they stay visible on the white card. Dark mode is unchanged.
- The score ring is now a plain SVG circle instead of a chart library drawing. It still animates, but the animation now stops for anyone whose system is set to reduce motion, which the library's animation ignored.
- The ring's leading edge is rounded and closes over its own start at a full score, instead of butting against it.

## v1.7.6

**What was fixed**

- The Overview page header now has a subtitle describing what the page shows (your privacy score, activity trends, and the sites you have visited), matching the Rankings & Stats page. It is translated in Spanish, French, and German like the rest of the interface.

## v1.7.5

**What was fixed**

- The Overview page has a top-level heading, so screen readers and the document outline see the same structure as the Rankings, Activity, and Settings pages.
- Locking the extension, clearing activity logs, and resetting your score now use the app's own confirmation dialog instead of the browser's plain confirmation box. The dialog follows your light or dark theme, is translated, and can be dismissed with the keyboard.
- Animations are turned off when your operating system is set to reduce motion. Slide, pulse, and chart animation no longer play in that mode.
- Page analysis no longer rescans every label in the document once per input field. On form-heavy pages this removes a large amount of duplicate work from each analysis.
- The Overview page reads the detector weights from the same source as the score itself, so its fallback can no longer disagree with the popup and the side panel.
- The "no data yet" hint on the score chart now meets the contrast requirement instead of rendering below it.

## v1.7.4

**What was fixed**

- Importing a backup now checks the file before writing anything. A malformed file can no longer leave half-restored settings, a non-list allow list, or an app state the rest of the extension cannot read.
- Backups larger than 50 MB are rejected with a clear message instead of being read into memory. The extension requests unlimited local storage, so a crafted file had no upper bound before.

## v1.7.3

**What was fixed**

- The vault key is no longer exposed to web pages. The extension used to open `chrome.storage.session` to untrusted contexts, and that area holds the key that decrypts your stored data, so a script running on any site could have read it. Developer mode events from the content script now travel through the background worker, which is the only context allowed to write there.
- Unreadable encrypted data is no longer replaced with an empty value. A failed decrypt used to be treated the same as "nothing stored", so one read error could overwrite your site cache, score history, personal-information journal, or notifications with only the newest entry. Those writes are now skipped and the failure is recorded.
- If the extension cannot read your vault settings, it now stays on the locked screen with an explanation instead of showing the account-creation screen. The old behavior let you create a new vault over an existing one and strand every encrypted entry.
- Settings and personal-information messages from the content script are validated before the worker acts on them. A malformed message used to throw inside the listener or store an unreadable value.

## v1.7.2

**What was fixed**

- The release workflow no longer substitutes the pushed tag name into a shell command. A tag containing shell syntax could have run arbitrary commands in the job that holds the Chrome Web Store signing credentials.
- Every dependency advisory is resolved (browserslist, js-yaml, postcss-selector-parser, and vitest with its bundled mocker), so `npm audit --audit-level=high` passes and the CI security gate is green again.
- Test coverage is now measured across the whole codebase, including the background worker, the content script, and the user interface. It previously counted only `src/lib` and the detectors, so the headline number described the least risky part of the extension.

## v1.7.1

**What was fixed**

- Turning on Developer mode now reaches the background worker straight away. It used to read the setting only when it started, so the most useful lines (page scores, reputation checks, personal-information decisions) could be missing from the log until Chrome happened to restart the worker.
- The popup, side panel, and dashboard each read the Developer mode setting for themselves. The popup never did, so anything it recorded at verbose level was thrown away, and it never contributed to the shared log.
- The copied diagnostics bundle now says when the log filled up and older events were dropped, and how many. A timeline that starts abruptly used to look like nothing happened, when in fact the beginning had been discarded.

## v1.7.0

**What's new**

- Developer mode records the full arithmetic behind your privacy score. Every UPS event (visit penalty, PII entry penalty, focus penalty, safe-site recovery, and safe-streak bonus or break) is now written as structured numbers instead of an ASCII tree in a console that disappears.
- The policy pipeline explains itself. Each rating lookup reports whether it came from the dynamic cache, the bundled seed, or a live fetch, whether a cached rating was stale, whether the seed overrode a cached miss, and whether the cloud lookup was disabled.
- Enrichment reports its hit rate. Cookies are counted by whether the Open Cookie Database identified them or the name-length heuristic guessed, and tracker candidates are counted by whether a database recognized them or they were dropped.
- Every personal-information decision is recorded: the gate evaluation (site score, reputation, allow list, reason), whether the confirmation card was shown, duplicate skips, and the penalty arithmetic with the resulting score.

## v1.6.0

**What's new**

- Developer mode now records why every score came out the way it did. Each detector reports its raw observation, its score, and how long it took. Each page reports the weights and the per-detector contributions behind its final safety score, so the arithmetic can be checked from the log alone. Each database load reports its entry count, and each reputation check reports which layer decided the result and how many domains the blocklist holds.
- Page-level detection now reaches the diagnostics bundle. The content script follows developer mode, so tracker counts, cookie counts, sensitive field types, fingerprinting techniques, and the ToS;DR source and grade are recorded. They were previously dropped, because the setting only applied to the background worker and the extension pages.

**What was fixed**

- Missing data is no longer silent. An unreadable or empty bundled database, a blocklist that failed to load, and a score that fell back to a neutral 50 all used to reach a developer console and nothing else. They are now recorded as failures, and a blocklist that never loaded shows up as `blacklistSize: 0` on every reputation check, which is the signal that reputation protection is effectively off.

## v1.5.1

**What was fixed**

- Browser layout warnings such as `ResizeObserver loop completed with undelivered notifications.` are no longer recorded as errors. They are not failures, and on the dashboard they were filling the error log and the Errors section of the copied diagnostics bundle. They still appear in the developer mode timeline, so nothing is hidden.
- Uncaught errors and unhandled promise rejections now name the context that raised them (background, content, popup, side panel, or dashboard). Every one of them used to be reported as "ui", which made a content script crash look like a dashboard crash.

**What's new**

- Developer mode records a scoring summary for every analyzed page: the final safety score plus the score from each detector. This replaces the completion line that the 1.4.3 console cleanup removed, so a score can now be traced back to the detectors that produced it.

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
