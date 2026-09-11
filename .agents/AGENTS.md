# Project Rules

- Always recompile the project when finished editing.
- When dealing with colors, always ensure they respect the light and dark theme toggle.
- When adding or replacing a UI section, it must be grabbed from an existing popular shadcn template.
- **Actionable Data over Vanity Metrics:** Always prioritize actionable and highly useful information over vanity metrics when designing data visualizations, charts, or dashboards. Ensure every data point provides genuine value or understanding of privacy risks.
- Never use em dashes in writing: comments, documentation, commit messages, and chat. Use commas, colons, parentheses, or separate sentences instead. This does not apply to product UI strings: translations and dashboard copy may keep em dashes.
- Be specific and precise in all writing. Name exact files, functions, and values. Avoid vague or filler phrasing.

## Commits

- Commit every change. Do not leave work uncommitted across turns: once a change is done and its typecheck, tests, and build pass, commit it before starting the next thing. You have standing permission to commit without asking each time; commit as the last step of the change, not as a separate request.
- One logical change per commit. Never bundle unrelated edits, and never sweep pre-existing dirty files into a commit for work you did not do.
- Use the repository's conventional style (`fix:`, `feat:`, `chore:`, `docs:`, `refactor:`, `test:`) and name the user-facing effect.
- Every commit and push is authored and committed as `Luca <lucaliceti+github@protonmail.com>`. Pass it per command (`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL`, or `git commit --author`), and never edit the git config to change it.
- Never credit an AI tool in this repository. No `Generated with ...` trailer, no `Co-Authored-By: Codebuff` line, and no other reference to Codebuff or any assistant in commit messages, code, comments, or docs.
- Include the version bump and the `CHANGELOG.md` entry in the same commit as the change they describe.
- Pushing stays explicit: commit locally every change, but run `git push` only when the user asks or when releasing (see Releasing). Never force-push and never rewrite history.

## Diagnostics and failure reporting

- Every failure path reports through `src/lib/diagnostics.ts`. Never ship a silent failure: no empty `catch {}`, no `.catch(() => {})`, and no `catch` that only writes to a console nobody has attached.
- Classify each `catch` when you write it. A genuine bug or broken invariant uses `captureError(area, error, eventName)`, which also lands in the durable error log. A transient or expected condition (worker asleep, network offline, invalid URL, optional data absent) uses `logEvent(area, 'warn', eventName, message)`, which stays in the session log.
- Pass only what is needed to reproduce the failure: host names, detector names, scores, error strings, and field types. Never log full URLs or anything the user typed.
- Keep the global `error` and `unhandledrejection` handlers installed in all four contexts: the background service worker, the content script, the popup, and the side panel plus dashboard entry points. Removing them is a regression.
- Developer mode (`devMode` in settings) is off by default. Verbose events persist only to `chrome.storage.session`, are wiped when the browser closes, and are never written to disk or synced. The About tab in `settings-modal.tsx` owns the toggle and the "Copy diagnostics" button.
- A detector that fails must never read as a clean result. When a detector returns a fallback score because it threw, record the failure so a broken detector is distinguishable from a safe site, and surface its status in the UI when you touch that path.

## Keeping these rules current

- This file is the living source of project conventions. When a change establishes a new workflow, convention, or standard, add or update the rule here in the same commit as the code, so every future agent or developer inherits it.
- Rewrite or delete rules that no longer match the code. A stale rule is worse than no rule.
- Rules name exact files, functions, commands, and settings keys.

## Versioning

- Follow SemVer (MAJOR.MINOR.PATCH). See VERSIONING.md for the full policy.
- package.json is the single source of truth for the version. Never edit the version anywhere else (manifest.json syncs automatically via the prebuild hook).
- Every change that ships counts as a new version. Bump the version in package.json for any extension change: PATCH for fixes, MINOR for features or additions, MAJOR for breaking changes or large redesigns.
- Include the version bump in the same commit as the change it describes.

## Releasing

- Release by tagging: bump the version with `npm version patch|minor|major`, then `git push && git push --tags`.
- The Release workflow builds `traceguard-extension-v<tag>.zip`, creates a GitHub release, and, if store credentials are configured (secrets `CHROME_WEB_STORE_CLIENT_ID`, `CHROME_WEB_STORE_CLIENT_SECRET`, `CHROME_WEB_STORE_REFRESH_TOKEN` and variable `EXTENSION_ID`), auto-uploads the ZIP to the Chrome Web Store.
- Store uploads are upload-only (submitted for review); publishing happens manually in the Chrome Web Store dashboard.
- If store credentials are not configured, the upload step is skipped and the ZIP is uploaded to the store manually by downloading it from the GitHub release.
