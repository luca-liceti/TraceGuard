# TraceGuard Roadmap: Footprint Assistant

**Created:** September 11, 2026
**Branch:** `dev`
**Status:** Phase 0 complete (branch + this document). Phase 1 not started.

---

## Why this direction

TraceGuard currently reports on *websites*: a per-site score and a site-visit table, opened
on demand. It already stores the user's own footprint data, but only ever displays it as
counts ("PII Risk Events: 47") or as rows keyed by site visit.

The goal is to make the product a **footprint assistant**: expose the user to their own
behaviour, reward good behaviour, and guide them away from bad behaviour in future cases.

That goal is mostly **not** an AI problem. It is a memory, timing, and reward-design
problem. Language is the smallest part, so it comes last.

---

## Branch workflow

- `main` is always shippable and is not touched by this work.
- `dev` is the long-lived integration branch. This roadmap lives here.
- Feature branches are cut from `dev` and merged back into `dev`.
- **Merge `main` into `dev` weekly.** A branch that does not absorb `main` diverges fast:
  merge conflicts accumulate, and until then `dev` is tested against stale code that is
  missing current fixes.
- Releases are still cut from `main` (see `AGENTS.md`).

---

## Phase 1: Footprint ledger (read-only), start here

**Goal:** put the user's own footprint in front of them, with no AI and no actions, so we can
find out whether the idea is worth building at all.

### Deliverables

| Item | Path |
|---|---|
| Pure aggregation, no `chrome.*` calls | `traceguard-extension/src/lib/exposure.ts` |
| Unit tests for the aggregation | `traceguard-extension/src/lib/exposure.test.ts` |
| `useExposureReport()` hook | `traceguard-extension/src/lib/useStorage.ts` |
| Page (read-only) | `traceguard-extension/src/components/traceguard/pages/exposure.tsx` |
| Route `/exposure` | `traceguard-extension/src/dashboard/App.tsx` |
| Sidebar entry | `traceguard-extension/src/components/app-sidebar.tsx` |
| Translations (en/es/fr/de) | `traceguard-extension/src/lib/translations.ts` |

### The report

Two lists, both deterministic:

- **What you handed over**: per field type (email, password, card…): which domains hold it,
  when it was first and last seen, and whether the entry is *surprising*.
- **Who has seen you**: tracker `organization` (from DuckDuckGo Tracker Radar) aggregated
  across visited sites, ranked by how many of the user's sites each organization covered.

Data sources, all already stored and encrypted:

- `crossSiteExposure`: `{ fieldType: string[] }` (field type to domains)
- `piiDetections`: `PIIDetectionEvent[]` (capped at 100; also used for dates)
- `siteCache[domain].enrichedDetails.trackers.items[].organization` (and `networkRequests`)
- `siteCache[domain]`: `wss`, `visitCount`, `lastVisit`

### Rules

- **`surprising` must be an explainable, deterministic rule**: for example `visitCount === 1`, or
  last visited long ago, or the entry happened on a site below the WSS threshold. If a row
  cannot be explained, it does not get the flag.
- **Compute in memory.** Do not introduce a new encrypted storage blob; read through the
  existing decrypt helpers.
- **Lead with the unexpected holders**, not with a count. "23 sites" is a scoreboard; "these
  4 you visited once, and they still have your email" is a finding.
- **Honest empty state.** On a fresh install the ledger is empty; it must explain that it
  fills as you browse, not look broken.
- **No landing-page change.** Overview stays where it is.

### Out of scope for Phase 1

Actions, AI, P2P, landing-page changes, and any change to the scoring model.

### Gate: decide before starting

Use the ledger on real browsing for **two weeks**. The gate passes if it names at least one
holder the user had genuinely forgotten about.

- **Pass** → proceed to Phase 2.
- **Fail** → stop. Do not build Phase 2 or 3. The direction is a receipt, not a tool.

The gate is agreed now so the decision is not made while invested.

### Estimate

Roughly 1–2 weeks of focused work, mostly aggregation logic, tests, and translations.

### Verification

`npm run typecheck`, `npm run test:run`, `npm run build`. Per `AGENTS.md`: a `CHANGELOG.md`
entry and a **MINOR** version bump.

---

## Phase 2: Make it actionable *(only if the Phase 1 gate passes)*

- `forgetExposure(fieldType, domain)` in `lib/storage.ts`.
  **Must also purge the matching `bufferedExposure` entry**, because the background
  `flushBufferedTelemetry` merges that buffer back in, so a naive delete is silently
  resurrected on the next flush.
- `trustSite(domain)` using the existing whitelist.
- Feed the ledger into the PII confirmation gate so it can warn **with memory**
  ("you've shared this with N sites") instead of asking "is this site safe?" fresh every time.
  This is where behaviour actually changes.
- Only two actions are honest: *forget* (deletes the local record, **not** the site's copy) and
  *trust*. TraceGuard blocks nothing, so "revoke" or "stop sharing" would be a lie.

**Estimate:** ~1 week.

---

## Phase 3: Optional local AI *(only after Phase 2 shows value)*

One setting, off by default, opt-in permission. Nothing here is ever a dependency of the core
product, so the deterministic view must work without it.

### 3a: Natural-language query box *(small; do this first)*

Sits on the Overview page, beside the UPS ring and the activity line graph (note: that grid is
currently two columns (the ring and the line graph), so it needs a third column or its own row).

- The model **routes** the question to the deterministic data; the answer comes from storage,
  so it cannot invent facts.
- Providers: the user's local server first, Chrome's built-in **Gemini Nano** as the zero-setup
  fallback. Both are 100% local: Chrome documents that no data is sent to Google or any third
  party when the built-in model runs.
- Gemini Nano is scoped to this job **only**.

### 3b: Local policy rating *(large; later)*

Covers the biggest hole in the scoring model: ToS;DR covers roughly 4,000 services, and when it
has no rating the policy detector is excluded and its weight redistributed, which inflates the
score for unrated sites.

- Runs only when ToS;DR has nothing for the site.
- **The user's own local model only.** This result feeds a score, so it needs a real model;
  Gemini Nano is too weak for rubric-based legal classification.
- Connect to a user-run local service (Ollama / LM Studio / llama.cpp) via an **optional host
  permission** for `http://localhost:*`, requested only when the user enables it. Restrict the
  endpoint to localhost by default.
- Only the **scraped policy text** is sent. Never the exposure ledger, logs, or anything else.
- Extract the policy text via the content script while the user is on the policy page, so no new
  network permission and no CSP change.
- Cache by a **normalized content hash** (strip dates, whitespace, navigation), not by domain.
  This also means one analysis covers every site sharing the same policy template.
- Re-analyse when the text changes (use a similarity threshold, not exact equality).
- Run inference off the critical path; show the analysis **age** and the **clauses it judged**,
  with a link to the original text.
- **Asymmetric by design: a generated rating may lower a score or stay neutral. It may never
  raise one.** Otherwise a confident wrong "good" inflates the WSS and can suppress a PII
  warning at the moment of risk.
- Record which model and prompt version produced each rating, so results can be invalidated.

**Estimate:** 3a ~1 week. 3b several weeks (chunking long policies, hash/diff logic, validation,
two failure modes per provider).

---

## Later: annotated, not scheduled

- **UPS reward redesign.** The current model is punishment-only: −2 per risky visit, +0.1 per
  safe one (~13 safe visits to recover from one risky visit, ~160 after a single PII penalty).
  Gamification cannot work on a score that only falls. Needs its own design document. Reward
  *actions the user takes*, not "safe site visits", because rewarding visit outcomes is farmable and
  teaches users to avoid risk *signals* rather than risk.
- **Promote `/exposure` to the landing page**, once it has proven useful.
- **Onboarding** for the empty-ledger period.
- **Sharing analyses.** If ever wanted: contribute to ToS;DR through its reviewed process, or
  export a file the user shares manually. Not P2P: see below.

---

## Explicitly not doing

- **P2P / decentralized contribution.** It contradicts the product's defining claim ("nothing
  leaves your device"), leaks browsing interest through domain metadata, and is a direct attack
  path: a contributed fake "A" grade inflates the WSS, which can make the PII gate exempt a
  phishing site. It also creates permanent content-moderation and takedown obligations.
- **Gemini Nano for policy rating.** Too weak for anything that touches a score.
- **Cloud AI.** Sending the visited site to a provider is a category error for a footprint
  assistant.

---

## Separate fixes, not part of this roadmap

- The dashboard's "blocked" counts credit blocking performed by *other* extensions
  (`net::ERR_BLOCKED_BY_CLIENT`). TraceGuard blocks nothing, so this overstates its role.
- The `crossSiteExposure` arrays grow without bound (flagged in `audit_report.md`, M-1). Phase 1
  reads this data, so a cap may become necessary.

---

## Open caveats

- "Who has seen you" depends on `enrichedDetails` tracker `organization` being populated. Older
  site-cache entries will make the early numbers thin.
- `piiDetections` is capped at 100 entries, so long-run history for the ledger must come from
  `crossSiteExposure`.
- The ledger is empty on install. Phase 1 ships nothing useful until the user has browsed.
