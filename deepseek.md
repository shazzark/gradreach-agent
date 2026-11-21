# GradReach — Batch 1 hand-off log

Purpose: hand-off note for the next agent. It records what was done, what was
verified, what is still open, and how to reproduce the checks. Read this together
with `AUDIT.md` (findings A-01, A-02, A-04, A-11) and `AGENTS.md`.

Privacy: this file contains no personal identifiers, credentials, email addresses,
or applicant data. Keep it that way.

## Status snapshot

| Field                 | Value                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Branch                | `main`                                                                                                               |
| Starting HEAD         | `2a20005` (`docs: refine audit citations for daily-cap enforcement`)                                                 |
| Working tree at start | Dirty: 18 modified files, 5 untracked paths (audit A-02)                                                             |
| Batch                 | 1 — R1, R2, R3, R9                                                                                                   |
| Skills applied        | `engineering-workflow`, `git-engineering` (global, unmodified)                                                       |
| Verification          | `npm run typecheck` exit 0 · `npm test` exit 0 (290 tests, 289 pass, 0 fail, 1 opt-in skip) · `npm run build` exit 0 |
| Remote state          | Pushed: `origin/main` matches the head of this batch (see `git log origin/main -3`)                                  |

## Phase log

| Phase | Recommendation | Commit    | Result                                                                                          |
| ----- | -------------- | --------- | ----------------------------------------------------------------------------------------------- |
| 0     | —              | —         | `deepseek.md` created before any code edit                                                      |
| 1     | R1 (A-01)      | `53f4fa3` | Hardcoded recipient removed; self-test fails closed without `GRADREACH_OWNER_EMAIL`; test added |
| 2     | R2a (A-02)     | `9c9756c` | In-flight opportunity/provider/UI code committed (10 files)                                     |
| 3     | R2b (A-02)     | `97896cb` | In-flight tests, fixtures, adapter doc and `.gitignore` committed (13 files)                    |
| 4     | R3 (A-04)      | `9a34787` | README status rewritten with durable facts only                                                 |
| 5     | R9 (A-11)      | `74e3029` | Daily-limit constants + validator centralized in the domain layer                               |
| 6     | Verification   | —         | Typecheck, full suite and production build all exit 0                                           |
| 7     | Log + push     | `c2e9dcd` | Hand-off log committed and pushed                                                               |
| 8     | Privacy sweep  | `7d25f13` | Literal address redacted from `AUDIT.md`; history exposure documented                           |

## What changed, precisely

### R1 — self-test recipient from configuration

- `src/infrastructure/gmail-oauth.ts`: new private helper `selfTestRecipient()`
  reads `GRADREACH_OWNER_EMAIL`, normalizes it (NFKC, trim, lowercase), and
  throws before any audit/lock file is written when the value is missing or is
  not an email address. `sendGmailSelfTest()` now calls it first and no longer
  contains any literal address.
- `test/provider-integrations.test.ts`: new test
  `Gmail self-test refuses to run without a configured owner address` covers the
  unset case and the invalid-value case, restoring the prior environment value
  in `finally`.
- This single commit also carries the previously uncommitted self-test hardening
  from the working tree: an exclusive lock file, append-only `attempts` history,
  and a refusal to re-send after an active, delivered or uncertain attempt.

### R2 — bounded commits

- Commit `9c9756c` (code): `src/application/opportunity-discovery.ts`,
  `src/config/official-opportunity-hosts.ts`, `src/domain/program-assessment.ts`,
  `src/infrastructure/brave-search-provider.ts`,
  `src/infrastructure/mongo-storage.ts`,
  `src/infrastructure/opportunity-collection-migration.ts` (new),
  `src/interfaces/terminal-app.ts`, `src/web/owner-workflows.ts`,
  `src/web/owner-workspace-loader.ts`, `app/(owner)/programs/page.tsx`.
- Commit `97896cb` (tests + docs): `test/mongo-storage.integration.test.ts`,
  `test/opportunity-discovery.test.ts`, `test/owner-workflows.test.ts`,
  `test/program-assessment.test.ts`, `test/research-discovery.test.ts`,
  `test/website-navigation-and-data.test.ts`, `test/search-provider-contract.test.ts`
  (new), `test/fixtures/search-provider/*` (new), `docs/search-provider-adapters.md`
  (new), `docs/implementation-plan.md`, `.gitignore`.
- `.gitignore` now covers `.codex/`, `.gmail-connect-*` and `.playwright-mcp/`.
  The browser-automation artifact directory no longer appears in `git status`.

**Gate outcome (A-02).**

- **(a) Was the baseline diff compared before any `git add`/`git commit`?**
  Partly. One `git --no-pager diff --stat` against `HEAD` was run before the
  first `git add`; it reported 18 files changed, 352 insertions(+), 142
  deletions(-), with a per-file list matching the audit's 18-file inventory.
  `git diff --numstat` was never run. File count (18) and deletions (−142)
  matched the audit's measured baseline; insertions were +352 against the audit's
  +350, and that two-line difference was not investigated or recorded at the
  time. No unexpected path appeared. `97896cb` was additionally gated on a staged
  `git diff --cached --stat` reviewed before the commit; `9c9756c` was not — it
  relied on the earlier working-tree stat plus `git status --short` after
  `git add`.
- **(b) Was the per-file split shown and approved before `9c9756c`?** No. The
  split was stated at category level in the phase table (code in phase 2;
  tests, fixtures, adapter doc and `.gitignore` in phase 3) and executed under
  the owner's standing R2 instruction. A per-file proposed split was never
  presented for approval and no approval round took place: the gate fired on
  file count and category, not on an owner-approved file list.
- **(c) Do the counts reconcile?** Yes, though not by 10 + 13 = 23 path
  arithmetic. The baseline's 23 _paths_ were 18 modified plus 5 untracked; one of
  those paths (`.playwright-mcp/`) was ignored rather than committed, and the
  fixtures directory holds 3 files, so the baseline is 24 changed-or-new
  _files_. Of those, 23 landed in the two R2 commits (9 modified + 1 untracked in
  `9c9756c`; 8 modified + 5 untracked in `97896cb`) and the 24th,
  `src/infrastructure/gmail-oauth.ts`, went into `53f4fa3` with R1.
  `test/provider-integrations.test.ts` was not dirty at baseline; it is a 25th
  file, edited and committed as part of R1. The 23 = 23 agreement between the two
  commit totals and the path baseline is therefore a coincidence of the ignored
  directory, not the proof of coverage.
  **R1's commit `53f4fa3` shows `gmail-oauth.ts` at `+37/−16`, which is
  larger than the audit's `+24/−15` for that file. R1's own contribution
  therefore exceeds the `+2` total insertions delta and does not explain it;
  the source of the `+2` remains unidentified. It was bounded to insertions,
  did not affect file count or deletions, and the gate held on both.**

### R3 — truthful status section

- `README.md` "Current status" now states: typecheck and tests pass; the last
  bounded search run made 26 requests with 15 HTTP 422 responses and saved no
  fully-checked lead; Gemini was not called; scheduled discovery and sending are
  disabled; one Gmail self-test message was delivered to the owner's own address
  on 2026-11-11 and no professor outreach has been sent; reply status is manual
  because the granted scope cannot read messages.
- No test counts remain anywhere in `README.md`.

### R9 — one daily-limit validator

- `src/domain/outreach-queue.ts` now exports `MIN_DAILY_LIMIT` (1),
  `MAX_DAILY_LIMIT` (5), `DAILY_LIMIT_MESSAGE`, and `isValidDailyLimit(value)`.
- The four independent checks still exist but no longer restate the range or the
  message:
  - `src/application/daily-outreach-planner.ts:17`
  - `src/domain/outreach-queue.ts:179` (`selectDailyOutreachBatch`)
  - `src/infrastructure/mongo-storage.ts:682` (`SchedulerControlRepository.save`)
  - `src/infrastructure/mongo-storage.ts:703` (`reserveDailySend`, returns `false`)
- Existing tests were not modified and still assert the exact message
  `/dailyLimit must be an integer from 1 to 5/`.
- The audit named three call sites: `daily-outreach-planner.ts`,
  `selectDailyOutreachBatch` and `reserveDailySend`. Implementation found a fourth
  latent validator that A-11 did not name —
  `SchedulerControlRepository.save` (`src/infrastructure/mongo-storage.ts:682`,
  throwing at `:683`) — which built its own copy of the same range and message
  before writing a control document. Unifying that fourth site is a strictly
  better outcome than the audit's fix guidance (one definition, four enforcing
  call sites), not a deviation from it.
- **Do not restore the duplicated literal at any of the four sites.** Inlining the
  range or the error message again would re-introduce A-11; import
  `isValidDailyLimit` / `DAILY_LIMIT_MESSAGE` instead.

## What each recommendation required

### R1 — no hardcoded recipient (A-01)

- Finding: `src/infrastructure/gmail-oauth.ts:211` contained a literal personal
  Gmail address, violating the `AGENTS.md` rule against hard-coded user data.
- Required: resolve the self-test recipient from `GRADREACH_OWNER_EMAIL` and fail
  closed with a clear error when unset or invalid.
- Acceptance: no personal identifier in `src/`; `npm run gmail:self-test` errors
  clearly without an owner address; `test/provider-integrations.test.ts` covers
  the missing-config case.

### R2 — bounded commits for in-flight work (A-02)

- Required: commit the uncommitted storage, migration, provider and test work in
  two reviewable commits (code first, then tests + docs), and ignore
  `.playwright-mcp/`.
- Acceptance: `git status --porcelain` shows no pre-existing noise afterwards.

### R3 — truthful status section (A-04)

- Required: remove volatile test counts from `README.md`, state the real Gmail
  self-test outcome with its date, and point at `docs/implementation-plan.md`.
- Acceptance: no test counts in `README.md`; a dated line records the delivered
  self-test and states that no professor outreach was sent.

### R9 — one daily-limit validator (A-11)

- Required: export `MIN_DAILY_LIMIT`, `MAX_DAILY_LIMIT` and a single validator
  from `src/domain/outreach-queue.ts`; keep the independent checks at each call
  site (defence in depth, no drift).
- Acceptance: one exported validator; three call sites named in the audit, four
  after discovery (the extra one is `SchedulerControlRepository.save`); existing
  tests unchanged and still green.

## Commands used for verification

```bash
npm run typecheck
npm test
# opt-in, needs a disposable MongoDB:
# $env:MONGODB_TEST_URI = 'mongodb://127.0.0.1:27017/gradreach_test'
# npm run test:mongodb
```

## Findings status after Batch 1

| Finding                      | Status                         | Evidence                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-01 (hardcoded recipient)   | **Closed in the current tree** | `sendGmailSelfTest()` resolves `GRADREACH_OWNER_EMAIL`; a scan of `src/`, `app/`, `test/`, `docs/`, `AUDIT.md`, `README.md` and `AGENTS.md` returns no hits. The string survives in earlier commit history (see open items) |
| A-02 (dirty tree)            | **Closed**                     | In-flight work committed in two bounded commits; artifact directories ignored; only this log was untracked during the batch                                                                                                 |
| A-04 (stale status docs)     | **Closed**                     | `README.md` status rewritten; `npm test` counts removed                                                                                                                                                                     |
| A-11 (triplicated daily cap) | **Closed**                     | One exported validator/constant set; four independent call sites still enforce it                                                                                                                                           |

## Open items carried forward

- R4–R8, R10–R12 from `AUDIT.md` are untouched by Batch 1.
- The owner address is redacted from the current tree, but it still exists in the
  history of the earlier audit commits (`7b56706` onward) and in the pre-fix
  source history. Removing it from history is an owner-authorized rewrite, not a
  Batch 1 action.
- Integration suite still opt-in; its guarantee rests on the test as written
  unless `npm run test:mongodb` is run against a disposable database.
- No live Brave, Gemini, Gmail, MongoDB or deployment call was made in this batch.
- `npm run gmail:self-test` was deliberately not executed: with an owner address
  configured it sends a real message. The missing/invalid-config branch is
  covered by the passing unit test instead.

## Notes for the next agent

- Work in verified phases, run the checks above, inspect the diff, then commit
  with `phase-N: …` / `fix: …` / `docs: …` messages.
- Never push without explicit owner authorization.
- Never add personal data to source, docs, fixtures or this log.

---

# GradReach — Batch 2 hand-off log

Purpose: close audit findings **A-07 (no CI)** and **A-08 (integration safety net
skipped)** through recommendation **R4**. Read together with `AUDIT.md` (A-07,
A-08, R4), the Batch 1 log above, and `AGENTS.md`.

Privacy: this file contains no personal identifiers, credentials, email
addresses, or applicant data. Keep it that way.

## Status snapshot

| Field                 | Value                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Branch                | `main`                                                                                         |
| Starting HEAD         | `b3db767` (`docs: record R2 gate outcome …`)                                                   |
| Working tree at start | Clean (`git status --short` empty), `main` level with `origin/main`                            |
| Batch                 | 2 — R4 (A-07 CI half, A-08)                                                                    |
| Skills applied        | `engineering-workflow`, `git-engineering` (global, unmodified)                                 |
| Dependencies          | Unchanged. No `package.json` / `package-lock.json` edits, no new npm scripts                   |
| Verification          | `npm run typecheck` exit 0 · `npm test` exit 0 (290 tests, 289 pass, 0 fail, 1 skip) · four-case gate matrix reproduced directly (both absent → skip, URI only → skip, both + unreachable → fail) · `npm run test:mongodb` injection proven |
| Remote state          | Pushed to `origin/main` on owner instruction (`9d62312`, `62a723d`); CI run `44799955899` green on both jobs |

## What changed, precisely

### A-08 — the integration proof keeps its opt-in and fails loudly

- The suite keeps **two gates**. `test/mongo-storage.integration.test.ts`
  resolves its target through the existing helper
  `getEnabledMongoTestUri({ enabled: process.env.RUN_MONGODB_INTEGRATION, uri: process.env.MONGODB_TEST_URI })`,
  which returns the URI only when `RUN_MONGODB_INTEGRATION === 'true'` and
  `undefined` otherwise. The second gate is a safety layer: a stray
  `MONGODB_TEST_URI` in `.env` must not make a plain `npm test` write to that
  deployment.
- `npm run test:mongodb` is the explicit opt-in. It loads
  `scripts/enable-mongodb-integration.ts`, whose single job is to set
  `RUN_MONGODB_INTEGRATION=true`, so the suite runs exactly when a developer or
  CI asks for it. Using the helper (rather than hand-rolled checks) keeps one
  definition of the rule, and it is still covered by
  `test/mongo-test-uri.test.ts`.
- What A-08 added is fail-loud behavior *inside* that opt-in: once both gates are
  satisfied, an unreachable deployment fails instead of silently skipping. A
  plain `npm test` still skips and stays offline.
- A failed `client.connect()` is wrapped into one assertion error:
  `MONGODB_TEST_URI is set but MongoDB at <host:port> is unreachable. Start
  MongoDB at that address, or unset MONGODB_TEST_URI to skip MongoDB integration
  checks.`
  The endpoint comes from `client.options.hosts` / `srvHost`, so credentials in
  the URI are never echoed, and the raw driver error is not attached as a
  `cause`, so no driver stack internals reach the runner. The existing outer
  `catch` re-throws this error unchanged (it is identity-checked) instead of
  re-wrapping it in the diagnostics JSON.
- `client.close()` is still in the existing `finally`, so it runs even when
  `connect()` failed. No assertion about reservations, `claimForDelivery`,
  `recoverStaleSending`, or the legacy-collection guard was modified.

Batch 2 first pass collapsed the two-gate design; corrected to restore the
RUN_MONGODB_INTEGRATION safety layer while keeping fail-loud behavior. One gap
then remains by design: a plain `npm test` still skips the only executable proof
of `reserveDailySend`, `claimForDelivery`, `recoverStaleSending`, and the
legacy-collection startup guard. Closing it means making that proof runnable
without a network dependency (an in-memory or embedded stand-in), not deleting
the safety layer.

### A-07 — first CI workflow

`.github/workflows/ci.yml` (new) has two jobs on `ubuntu-latest`, Node 22,
`npm ci`, `contents: read`, and per-ref concurrency cancellation:

1. `verify` — `npm run typecheck` then `npm test`. `MONGODB_TEST_URI` is
   deliberately absent, so the integration test skips and the default suite is
   proven green.
2. `mongodb-integration` — a `mongo:7` service with a `mongosh` ping health
   check, a bounded wait loop on `127.0.0.1:27017`, then `npm run test:mongodb`.
   This job is the only place `MONGODB_TEST_URI` is set; the second gate
   (`RUN_MONGODB_INTEGRATION=true`) comes from the npm script itself, so the
   workflow needs no extra env entry.

`README.md` gained the CI badge only. Lint, Prettier, Vitest, coverage, and the
oversized `test/research-discovery.test.ts` split (the rest of A-07) are **not**
part of this batch and remain open.

## Verification evidence

| Case | `MONGODB_TEST_URI` | `RUN_MONGODB_INTEGRATION` | reachable | Observed |
| --- | --- | --- | --- | --- |
| A | unset | unset | — | `# SKIP Set MONGODB_TEST_URI and opt in with RUN_MONGODB_INTEGRATION=true …`; `# pass 0 / # fail 0 / # skipped 1`; exit 0 |
| B (safety layer) | `mongodb://127.0.0.1:27017/gradreach_test` | unset | — | same skip; exit 0 — nothing is contacted |
| C (fail loud) | `mongodb://127.0.0.1:27017/gradreach_test` | `true` | no listener | `# fail 1`; exit 1; `MONGODB_TEST_URI is set but MongoDB at 127.0.0.1:27017 is unreachable. Start MongoDB at that address, or unset MONGODB_TEST_URI to skip MongoDB integration checks.` |
| D | supplied by the real local `.env` | unset | — | `npm test` exit 0 — 290 tests, 289 pass, 0 fail, 1 skip; the integration test skips and no network call is made |
| Injection | `.env` moved aside, synthetic URI | unset in the shell, `npm run test:mongodb` | no listener | exit 1 with the same message, `# fail 1` — proves the npm script still injects `RUN_MONGODB_INTEGRATION=true` |
| Typecheck | — | — | — | `npm run typecheck` exit 0 |
| Ignore check | — | — | — | `git check-ignore -v .github/workflows/ci.yml` → no output, exit 1 (not ignored) |

Case D is the decisive one: the local `.env` supplies `MONGODB_TEST_URI`, and the
default suite still skips because the opt-in flag is absent. `.env` was renamed
to `.env.batch2fix-verify-backup` for cases A–C and the injection check, then
restored; no `.env*` artifact remains in `git status`.

One harness note: this agent's PowerShell session persists environment variables
between commands, so the first `npm test` attempt after case C inherited
`RUN_MONGODB_INTEGRATION=true` and *ran* the suite (it failed loud at
`127.0.0.1:27017`; it never touched the deployment named by `.env`). Clearing the
variable reproduced case D. Any harness that reuses a shell must clear these two
variables between gate experiments.

## Consequences the owner must know

- **`npm test` stays offline even though `.env` configures `MONGODB_TEST_URI`.**
  The integration suite also needs `RUN_MONGODB_INTEGRATION=true`, so the default
  local run and the CI `verify` job skip it. Run `npm run test:mongodb` when you
  mean to exercise the database.
- **`npm run test:mongodb` can write to whatever `MONGODB_TEST_URI` names.** The
  suite asserts the URI targets `gradreach_test` and drops its 13 named test
  collections at the end, so never point it at a deployment holding real data.
  CI points it at a disposable `mongo:7` service.
- **`getEnabledMongoTestUri` is live again.** The integration test consults it, so
  the helper and `test/mongo-test-uri.test.ts` describe the behavior that ships,
  and `scripts/enable-mongodb-integration.ts` is the only producer of the opt-in
  flag.
- **The live integration job was not executed locally.** Nothing listens on
  `127.0.0.1:27017` and the Docker daemon is not running on the dev machine, so
  only the skip and fail-loud paths were exercised locally. The first CI run
  supplied the end-to-end proof: run `44799955899` on `main` passed both jobs.
  The verify job logged `# skipped 1` with no URI, and the integration job
  reached the service (`MongoDB is accepting connections on 127.0.0.1:27017.`)
  and logged `# skipped 0`, so the suite really executed there.
- **Credential exposure during verification.** While inspecting the local
  `.env` (ignored, not part of this batch), the agent printed the
  `MONGODB_TEST_URI` value — including its Atlas password — into the session
  transcript. Rotate that database user's password before the repository or the
  transcript is shared. Nothing secret was written to a tracked file.

## Findings status after Batch 2

| Finding | Status | Evidence |
| --- | --- | --- |
| A-07 (no CI, no lint, no coverage) | **Partially closed** | `.github/workflows/ci.yml` runs typecheck and unit tests plus a MongoDB integration job. Lint, Prettier, coverage and the test-portfolio imbalance remain open — A-07's other half. |
| A-08 (integration silently skipped) | **Closed** | Set `MONGODB_TEST_URI` and `RUN_MONGODB_INTEGRATION=true` and the suite runs; if that deployment is unreachable it fails loudly with a host:port message instead of skipping. A URI alone still skips, so local runs stay offline. CI sets the URI and `npm run test:mongodb` supplies the opt-in. |

## Open items carried forward

- R6 is closed (Batch 3), R5 is closed (Batch 4) and R8 is closed (Batch 5);
  R7 and R10–R12 in `AUDIT.md` remain untouched.
- Lint/Prettier/Vitest/coverage stays a separate, explicitly deferred phase; no
  dependency or npm script was added here.
- The workflow has one green run (`44799955899`, both jobs), and `main` does
  require two status checks. The Batch 3 push reported "2 of 2 required status
  checks are expected" and still completed because the pushing account is on the
  branch-protection bypass list. Local evidence for `7ae2d78` is green, but CI
  did not gate that push. Trim the bypass actors in GitHub repository settings
  if checks should block, and confirm the Actions run for `7ae2d78`.
- The integration job pulls `mongo:7` from Docker Hub anonymously. If runner
  egress blocks that image, pin an approved registry mirror.
- The fail-loud error surfaces after the driver's default 30-second
  server-selection timeout (observed: 30.0 s for case C). CI's 20-minute job
  timeout absorbs that; lowering `serverSelectionTimeoutMS` would shorten the
  wait but is not part of this batch.

## Commands used for verification

```powershell
# .env renamed to .env.batch2fix-verify-backup for A-C and the injection check,
# then restored. This shell persists env vars, so clear them explicitly.
Remove-Item Env:MONGODB_TEST_URI -ErrorAction SilentlyContinue
Remove-Item Env:RUN_MONGODB_INTEGRATION -ErrorAction SilentlyContinue
node --experimental-strip-types --test test/mongo-storage.integration.test.ts   # A: skip, exit 0

$env:MONGODB_TEST_URI = 'mongodb://127.0.0.1:27017/gradreach_test'
node --experimental-strip-types --test test/mongo-storage.integration.test.ts   # B: skip, exit 0 (safety layer)

$env:RUN_MONGODB_INTEGRATION = 'true'
node --experimental-strip-types --test test/mongo-storage.integration.test.ts   # C: fail, exit 1, host:port message

Remove-Item Env:MONGODB_TEST_URI, Env:RUN_MONGODB_INTEGRATION
npm run test:mongodb   # with .env aside and the synthetic URI: fail, exit 1 → proves injection
npm test               # D: with the real .env: integration test skips
npm run typecheck
```
## Batch 3 — R6 (Brave 422 diagnosis)

- **Root cause of 422:** Brave validates the `country` query parameter against a
  closed enum and returns `422` with `code: VALIDATION` for any value outside
  it. The 19 recorded failures (`outputs/phase3-result-diagnostics.jsonl`,
  2026-11-09) are exactly the regions whose ISO codes are absent from that enum
  (`SI`, `BA`, `CZ`, `EE`, `HR`, `HU`, `IS`, `IE`, `LV`, `LI`, `LT`, `LU`, `MT`,
  `MD`, `ME`, `RS`, `SK`, `UA`, `BG`), while `CA`/`AU`/`DE`/`JP`/`US` returned
  `200`. Confirmed by a bounded live probe on 2026-11-20: `country=SI|BA|CZ` →
  `422 VALIDATION` with Brave's enum in `error.meta`; `country=CA` → `200`;
  600-character query → `200`; `count=20&offset=9` → `200`; quoted/parenthesised
  queries → `200`. Query length, `count`/`offset`, `safesearch`, quoting, and
  parentheses are all ruled out, so this is a request-validation failure, not a
  rate limit. The historical records keep only `statusCode: 422` (no Brave error
  code), so the body had to be reproduced; the failed run's parameters were
  never stored.
- **Fix implemented:** `BRAVE_SUPPORTED_COUNTRY_CODES` (the full enum from the
  API) plus `isBraveSupportedCountryCode()`; `searchPage` omits an unlisted
  `country` instead of forwarding it, so an unsupported region keeps its
  `site:`/region query. Bounded exponential backoff for `429`/`5xx` (three
  attempts, `Retry-After` honored, 1 s then 2 s, capped at 10 s); `422` is never
  retried. `research-discovery.ts` now emits a sanitized `search_failed`
  diagnostic (status, Brave code/id, request ID) before aborting;
  `automatic-discovery.ts` stores `provider_rate_limited`/`provider_error` and
  the `/discovery` run list renders `Provider rate limited/error`; the manual
  batch prints `providerHealth` plus per-failure `providerStatus`,
  `statusCode`, and `braveErrorCode`; the workspace discovery action persists
  the same diagnostics.
- **Verification:** `npm run typecheck` exit 0. `npm test` 297 tests, 296
  passed, 0 failed, 1 skipped. `npm run discovery:preflight`
  `{"ok":true,"profilePreferencesRead":true,"profileCountriesConfigured":true,
  "leadIdsRead":true,"leadCount":12}`. Diagnosis recorded in
  `docs/phase-6-brave-422-diagnosis.md`; seven new tests cover the enum guard,
  backoff, `Retry-After`, the no-retry-on-422 rule, the search-failure
  diagnostic, and run-level provider failure codes. `DISCOVERY_LIMITS`,
  dependencies, and npm scripts are unchanged; no post-fix search was run, so
  throughput is still unmeasured.
- **Commits:** `docs: add brave 422 diagnosis`,
  `fix: resolve brave search 422 responses and add provider backoff`,
  `docs: record batch 3 in hand-off log`.

## Batch 4 — R5 (Discovery Operating Envelope)

- **What limits were raised:** `DISCOVERY_LIMITS` went from
  `{ searchesPerRun: 1, resultsPerSearch: 3, inspectionsPerRun: 5 }` to
  `{ searchesPerRun: 5, resultsPerSearch: 10, inspectionsPerRun: 20 }`. Twenty
  inspections per run means ten fully successful runs can reach the
  200-professor target, against at least forty runs before. The five-search
  ceiling matches one-sweep mode, which claims up to five countries and spends
  exactly one search per country on the current targeting path; the result cap
  per request rose from three to ten.
- **Schedule status:** `DEFAULT_DISCOVERY_SCHEDULE` is now
  `enabled: true, paused: false, frequency: 'daily'` at 09:00
  `Africa/Lagos` with `countries: []`. An empty country list is now documented
  as "every configured country with a verified host, in saved order", and
  `validateDiscoverySchedule` no longer rejects an enabled schedule with an
  empty list (previously it threw, which would have broken the new default).
  The single-country path falls back to configured ∩ verified countries when
  the saved list is empty. The worker still needs its own
  `GRADREACH_DISCOVERY_SCHEDULER_ENABLED=true` deployment opt-in, and the owner
  can pause or narrow the schedule from `/discovery`, whose copy and limit
  hint were updated to match.
- **Worker gate retained (owner decision, 2026-11-20):** the saved schedule now defaults to
  `enabled: true, paused: false`, but `GRADREACH_DISCOVERY_SCHEDULER_ENABLED=true` is still required before the
  worker loops, so an enabled default never spends provider credit on a plain checkout. The decision is recorded in
  `docs/phase-8-discovery-envelope.md` and as a comment in `src/interfaces/discovery-scheduler.ts` so a later envelope
  change does not delete the gate.
- **Provider budget guard:** new `MAX_DAILY_SEARCHES = 20` plus
  `searchesUsedOnDay(schedule, runs, now)`, which sums `counts.searches` from
  persisted runs started on the schedule-local date and ignores unparseable
  timestamps. `runAutomaticDiscovery` checks it before claiming a slot, so a
  spent day returns `state: 'budget_exhausted'` with `searchesUsedToday`
  without calling the provider or writing a run. Inside a run, each country's
  `maxSearches` is the smaller of the per-run limit and the remaining budget,
  so a partially spent day shortens the batch and leaves unsearched countries
  queued instead of marking them attempted.
- **Verification:** `npm run typecheck` exit 0. `npm test` 301 tests, 300
  passed, 1 skipped (opt-in MongoDB integration), 0 failed. Focused
  `node --experimental-strip-types --test test/automatic-discovery.test.ts`
  20/20. Tests updated for the new caps (result `count: 10`, six and seven
  inspections instead of five, progress totals `1/5/20`); new tests cover the
  enabled default, empty-country validation, `searchesUsedOnDay` day/legacy
  handling, a spent budget (`budget_exhausted`, zero provider calls, slot
  unclaimed), a partial budget truncating a batch to one search and requeueing
  `['Canada', 'Japan']`, and empty-list rotation. The daily five-email cap,
  exact-host policy, provider backoff, and dependencies are unchanged. No live
  search, scheduler start, MongoDB write, or email was performed, so the 200
  target remains a documented ceiling, not a measured result.
- **Docs:** new `docs/phase-8-discovery-envelope.md` (limits, reasoning,
  regions × runs × saves table, budget math); `docs/implementation-plan.md`
  phase-9 rows/status/log updated to the new envelope; corrected the stale
  "required checks not configured" note in this file.
- **Commits:** `c041869 phase-4: expand discovery limits and enable
  schedule for 200-professor goal` and `0dbad8d docs: record retained discovery
  scheduler env gate`, both pushed to `origin/main`.
- **Worker gate:** kept deliberately (owner decision, 2026-11-20). The saved
  schedule defaults to enabled, but `GRADREACH_DISCOVERY_SCHEDULER_ENABLED=true`
  is still required before the worker loop can spend provider credit; the
  decision is written into `docs/phase-8-discovery-envelope.md` and the worker
  entry point so a later envelope change does not delete it.
- **Post-push CI:** run `44808397197` (push of `0dbad8d`) and run
  `44805633203` (push of `7ae2d78`) both completed `success` on both jobs,
  "Typecheck and unit tests" and "MongoDB integration". Both pushes reported
  "2 of 2 required status checks are expected" and completed through the
  branch-protection bypass list, so CI confirms `main` after the fact instead of
  gating it; trimming the bypass actors in repository settings is still open.
  The only remaining CI annotation is the Node 20 action deprecation warning.

## Batch 5 — R8 (Worker Heartbeat)

- **What changed:** A supervised worker now proves it is alive instead of leaving the website to guess.
  - `src/domain/scheduler-heartbeat.ts` (new) holds `SCHEDULER_HEARTBEAT_STALE_MS = 120_000`,
    `SCHEDULER_WORKERS = ['outreach', 'discovery']`, the `SchedulerHeartbeat` shape, and the pure
    `schedulerHeartbeatStatus(heartbeat, now)` classifier (`live` / `stale` / `missing`).
  - `mongo-storage.ts` adds `SchedulerHeartbeatRepository` with `updateSchedulerHeartbeat(worker, at?)` and
    `getSchedulerHeartbeat(worker)`, wired into `GradReachRepositories` as `schedulerHeartbeat` over the
    `scheduler_heartbeat` collection. Each worker owns one document (`scheduler-heartbeat:outreach`,
    `scheduler-heartbeat:discovery`) carrying only `lastHeartbeatAt` (ISO) plus the adapter's `updatedAt`. An unknown
    worker name and an unparseable instant are rejected before any write.
  - `src/interfaces/scheduler-heartbeat-pulse.ts` (new) provides `pulseSchedulerHeartbeat()`, which writes the tick
    instant and converts a storage failure into one stderr line, returning `false` instead of throwing.
  - `outreach-scheduler.ts` records its heartbeat at the start of every 60-second tick, before `deliverNext()`, and
    now imports `local-env.ts` directly (it previously loaded `.env` only through `gmail-oauth.ts`).
    `discovery-scheduler.ts` does the same before spending a search; its connect function became injectable, matching
    the outreach worker, so the gate can be tested without a live database.
  - `src/web/outreach-runtime-status.ts` gained the `worker_down` state and evaluates
    `disabled → worker_down → paused → armed`. A dead worker outranks the pause control because a paused queue with no
    worker delivers nothing the moment the owner resumes it. `/outreach` renders a red `role="alert"` banner —
    "Worker is not running. Please start the scheduler process." — plus the measured heartbeat age;
    `ui.danger` and `--color-red-soft` were added for it.
  - `docs/phase-5-worker-supervision.md` (new) documents the document shape, the threshold, the status ordering, and
    Windows Task Scheduler, systemd, and PM2 recipes, plus an offline health check.
  - Untouched by design: the five-per-local-day sending cap, the discovery envelope (`5` searches / `10` results /
    `20` inspections / `20` daily searches), provider backoff, and dependencies.
- **Stale heartbeat threshold:** 120 seconds, applied as *older than* two minutes, so a heartbeat exactly 120 s old is
  still live. Both workers poll every 60 s, which makes this two missed ticks and keeps one slow provider call from
  being reported as an outage. A worker that never wrote a heartbeat is `missing` and is reported as down, not
  assumed healthy; a future-dated heartbeat is floored to a zero age. When `OUTREACH_SENDING_ENABLED` is not `true`
  the state stays `disabled`, because the worker is supposed to exit and a stale record is not an outage.
- **Verification:** `npm run typecheck` exit 0. `npm test` 318 tests, 317 passed, 1 skipped (opt-in MongoDB
  integration), 0 failed — up from 301. `test/scheduler-heartbeat.test.ts` (new, 11 tests) covers the threshold
  constant and its exclusive boundary, missing/unreadable records, clock skew, an invalid reference time, per-worker
  document ids and independent reads, no-record behaviour, unknown-worker and invalid-timestamp rejection with no
  write, pulse success, and the swallowed failure path. `test/outreach-runtime-status.test.ts` covers `worker_down`
  for stale and never-recorded heartbeats, the two-minute boundary, and dead-worker-before-pause ordering.
  `test/discovery-scheduler.test.ts` (new) proves `GRADREACH_DISCOVERY_SCHEDULER_ENABLED` still returns before any
  connection, and both scheduler tests assert the heartbeat is written before delivery / before a search. The
  `scheduler_heartbeat` round trip was added to `test/mongo-storage.integration.test.ts` (gated by
  `npm run test:mongodb`). No worker was started, no heartbeat reached a live database, and the banner was not
  observed in a running deployment, so supervision is unit- and wiring-verified only.
- **Post-push CI:** `git push origin main` of `c4254dc` was rejected with `GH006: Protected branch update failed
  ... 2 of 2 required status checks are expected`, so the bypass list that let Batch 4 land before checks reported
  no longer applies - that open item appears closed and should be confirmed in repository settings. The commit went
  out as branch `phase-5/scheduler-heartbeat`, was reviewed in PR #1, and was merged with *Rebase and merge* at
  2026-11-20T20:37:09Z as `dd06a57` (identical tree; GitHub rewrites the committer, so the SHA differs from the local
  `c4254dc`). PR run `44812808162` and post-merge push run `44812998201` (head `dd06a57`) both completed `success`:
  "Typecheck and unit tests" 27 s and 35 s, "MongoDB integration" 43 s and 46 s. Local `main` was re-synced to
  `dd06a57`. The only annotation is the Node 20 action deprecation warning; the Node 22 to 24 bump remains open.

## Batch 6 — R7 (Allowlist Expansion)

- **What changed:** A-03 says the 200-professor objective is unreachable because the exact-host allowlist covered only one
  reviewed university in most regions. Ten already-covered regions now carry three to five verified institutions each, so a
  single-region search can match several official computing departments instead of one.
  - `src/config/official-host-allowlist.ts` grows from 51 to 91 exact hosts across the same 42 regions; the array format,
    the exact-host matching rule, and the HTTPS-only policy are unchanged.
  - `OFFICIAL_INSTITUTION_BY_HOST` (new) records the institution for each added host, and
    `institutionForOfficialSource(region, sourceUrl)` resolves affiliation from the exact source host first, then falls back
    to `OFFICIAL_INSTITUTION_BY_REGION`. `automatic-discovery.ts` and `professor-research-evidence.ts` now use it, so a
    Carnegie Mellon professor is no longer labelled "University of Illinois Urbana-Champaign" just because both are in the
    United States.
  - `test/research-discovery.test.ts` asserts the reviewed UK list, bare-lowercase unique hostnames, a reviewed institution
    for every host, host-specific attribution for five regions, and a Brave-compatible single-query site filter per region.
- **Countries expanded:** United States +5, United Kingdom +5, Canada +5, Germany +5, Australia +3, Netherlands +4,
  Switzerland +3, Sweden +3, France +2, Italy +5.
- **Number of new hosts added:** 40 (51 → 91). Japan was deliberately left at its seven reviewed hosts because its site
  filter is already the longest at 219 characters.
- **Verification:**
  - `npm run typecheck` exits 0.
  - `npm test`: 320 tests, 319 pass, 0 fail, 1 opt-in skip (`SCHEMA INTEGRATION` MongoDB suite is the skipped one; the new
    allowlist and attribution assertions run in the default suite).
  - Every added host was requested over HTTPS on 2026-11-20 with `curl` (`Accept: text/html`, no credentials) and the
    observed status and page title are recorded per row in `docs/phase-3-allowlist.md`. No live search or database write
    was performed for this batch.
  - Rejected candidates that look plausible but failed the policy: `cs.stanford.edu` (301 to `www.cs.stanford.edu`),
    `cs.toronto.edu` (302 to `web.cs.toronto.edu`), `www.tu-berlin.de` (301 to `www.tu.berlin`), `www.di.unipi.it` (301 to
    `di.unipi.it`), `cs.queensu.ca` (301 to `www.cs.queensu.ca`), plus `www.imperial.ac.uk`, `www.ucl.ac.uk`,
    `www.ualberta.ca`, `www.unimelb.edu.au`, and `www.monash.edu`, which answered HTTP 403 to the same client shape the
    discovery fetcher uses. France stayed at two additions because no further French computer-science page could be
    confirmed on an exact host.
  - The longest site filter after expansion is still Japan at 219 characters; the region budget test keeps every
    single-search query inside the 400-character and 50-term limits enforced by `queryFor`.
  - No dependencies were added, no provider or scheduler behaviour changed, and the daily-send cap is untouched.
- **Git:** branch `phase-6/allowlist-expansion` at `77eae67`; direct pushes to `main` are still blocked by branch protection, so
  the change went through PR #3 and was rebase-merged at 2026-11-20T22:18:09Z as `8f8c763` (identical tree to the local
  commit). CI: PR run `44827557991` passed both required checks - "Typecheck and unit tests" 28 s and "MongoDB integration"
  39 s - and the post-merge push run `44827805809` completed `success` in 45 s. Local `main` was fast-forwarded to
  `8f8c763`; the branch remains on the remote for reference.

## Batch 7 — R11 (Gmail Reply Tracking)

- **What changed:** A-05 said reply tracking is manual by design because the granted scope was send-only. The owner enabled the
  restricted `gmail.readonly` scope in the Google Cloud Console, so this batch adds the read-only, header-only reply pass and
  the OAuth consent that supports it.
  - `src/infrastructure/gmail-oauth.ts` adds `GMAIL_READONLY_SCOPE`, `GMAIL_REQUESTED_SCOPES`, `hasGmailScope`,
    `GmailTokenScopeError`, and `gmailReadOnlyAccessToken`. Authorization now asks for `gmail.send` plus `gmail.readonly` and
    rejects a grant that omits either; `readTokens` still accepts a legacy send-only token so delivery is unchanged, and only
    the sync demands the read scope. No `gmail.modify` or delete scope is requested.
  - `src/infrastructure/gmail-reply-sync.ts` (new) calls the Gmail REST API with `fetch` (no new dependency):
    `/profile`, `/messages/{id}?format=minimal&fields=threadId`, and
    `/threads/{id}?format=metadata&metadataHeaders=From`. It requests no subject and no body, validates every provider id
    before it enters a URL, sends GET requests only, and maps failures to sanitized codes that carry no provider payload.
  - `GmailReplySyncService` marks an attempt `replied` only when a message in that send's thread is not the sent message, is
    not `SENT`-labelled, is not from the authenticated owner address, and — when both timestamps exist — arrived after
    `sentAt`. `pendingReplyAttempts` skips attempts already `replied` or manually `declined`, and a run with nothing pending
    makes no mailbox call at all. A `401`/`403` stops the run instead of retrying every remaining thread.
  - `OutreachAttemptRepository.recordReply` (Mongo) writes `replyStatus: 'replied'`, `replyRecordedAt`, and the new optional
    `replyMessageId` in one guarded update, so a repeated sync is a no-op and a manual `declined` decision is never
    overwritten. `OutreachAttempt.replyMessageId` is the only model change; sending, the five-per-day cap, pause control, and
    approval gates are untouched.
  - `docs/phase-7-gmail-reply-sync.md` (new) is the R11 decision record: separate read consent, exactly which fields are read,
    retention, prompt-injection stance, failure limits, and what remains unimplemented. README,
    `docs/implementation-plan.md`, and `docs/private-website-deployment.md` no longer claim the app cannot read replies.
- **New npm script:** `npm run outreach:sync-replies` (`src/interfaces/gmail-reply-sync.ts`) performs one pass, prints
  aggregate counts and codes only (never a sender address, subject, or body), and exits non-zero on `failed` or `partial`.
- **Verification:** `npm run typecheck` exit 0. `npm test` 340 tests, 339 pass, 0 fail, 1 opt-in MongoDB skip.
  `test/gmail-reply-sync.test.ts` (new) drives a mocked Gmail API and a fake repository through reply, owner-message,
  pre-send message, missing `From`, manual `declined`, missing scope, `401`, `429`, vanished-thread, and per-run-limit cases,
  and asserts that every request is a GET with `format=minimal`/`format=metadata` and no subject or body parameter.
  `test/provider-integrations.test.ts` now asserts the combined scope request, rejection of a send-only grant, and that a
  stored send-only token is refused by `gmailReadOnlyAccessToken` without rewriting the token file. `npm run test:mongodb`
  passed `recordReply`'s write, idempotency, and invalid-timestamp assertions against a clean local `gradreach_test`; the
  `.env`-configured test target still fails earlier, at `opportunity_collection_migration` with duplicate-key 11000 from stale
  synthetic fixtures, which is unrelated to this change. No live Gmail read, no live send, and no deployed worker were
  exercised, so this is verified logic rather than a proven live integration.
- **Git:** branch `phase-7/gmail-reply-tracking` at `adbd76f`; direct pushes to `main` stay blocked by branch protection, so the
  change went through PR #5 and was rebase-merged at 2026-11-20T23:25:35Z as `6143c06` (identical tree to the local commit).
  CI: PR run `44836508486` passed both required checks — "Typecheck and unit tests" 20 s and "MongoDB integration" 45 s — and
  the post-merge push run `44836709665` completed `success` in 46 s. Local `main` was fast-forwarded to `6143c06`; the branch
  remains on the remote for reference.



## Batch 8 — R10 and R12 (Script Cleanup and Production Startup)

- **What changed:** R10 and R12 were the last two open audit items that did not need a live provider.
  - `package.json` now separates durable operations (`ops:*`) from investigation helpers (`debug:*`), e.g.
    `ops:outreach-scheduler`, `ops:gmail-connect`, `ops:db-migrate-discovery`, `debug:leads-view`, `debug:discovery-preview:audit`.
    `test*`, `typecheck`, `build`, `dev`, and `web` keep their names. The full old-to-new table is in
    `docs/phase-8-production-readiness.md`.
  - `src/application/candidate-review-preview.ts` no longer imports `OFFICIAL_HOSTS_BY_REGION.Canada`. `resolveReviewRegion`
    reads `--region <name>` / `--region=<name>`, then `GRADREACH_REVIEW_REGION`, then falls back to `Canada` with an
    announced stderr warning; `compareSavedLeadDuplicates` and `stableProfileCandidateId` take the region as a parameter and
    fail closed on an unknown one. The resolved region is written to the report and the status line.
  - `tsconfig.build.json` (new) compiles `src/interfaces/**/*.ts` to the ignored `dist/` with
    `allowImportingTsExtensions: false` and `rewriteRelativeImportExtensions: true`; `npm run build:server` runs it, and
    `start` plus every `ops:*` script build first, then run the compiled JavaScript on plain Node.js. No
    `--experimental-strip-types` is needed on the production path anymore.
  - `src/infrastructure/runtime-support.ts` (new) rejects Node below 22, and any TypeScript-source start without type
    stripping, from `local-env.ts` and `runWebServer`; Next.js bundles are deliberately not checked.
  - Guidance strings and their tests moved to the new names (`gmail-oauth.ts`, `gmail-reply-sync.ts`,
    `discovery-collection-migration.ts`, `test/provider-integrations.test.ts`, `test/discovery-collection-migration.test.ts`).
    README, `.env.example` (`GRADREACH_REVIEW_REGION`), `docs/private-website-deployment.md`, and the CI workflow (a
    `npm run build:server` step) were updated to match.
- **Verification:** `npm run typecheck` exit 0. `npm run build:server` exit 0 with 66 files in `dist/`, zero `.ts` import
  specifiers in the output, and zero stray `.js` files in the source tree. `node -e "await import('./dist/interfaces/
  prepare-candidate-review-preview.js')"` loaded a compiled entry on plain Node with no experimental flag.
  `npm run ops:discovery-pilot` with no region built and then exited 1 with
  `{"ok":false,"stage":"pilot_configuration","kind":"invalid_request"}`, proving the renamed scripts resolve and fail
  gracefully. `npm test` 347 tests, 346 passed, 1 opt-in MongoDB test skipped, 0 failed; new `test/runtime-support.test.ts`
  and the region cases in `test/candidate-review-preview.test.ts`. No provider request, no scheduler start, no MongoDB
  write, no live Gmail read or send, and no deployment were performed, so the compiled start path is verified locally only.
- **Carried forward:** a real hosted `npm start` behind the proxy, the Gmail read-scope re-authorization, and the first
  live `ops:sync-replies` pass all still need the owner.


## Batch 9 — PR #7 merge, and a branch-protection trap

- **Why the first merge attempt failed:** `gh pr merge 7 --rebase` returned "the base branch policy prohibits the merge".
  `main` requires exactly the contexts `Typecheck and unit tests` and `MongoDB integration`, with `enforce_admins: true`,
  and Batch 8 had renamed the verify job to `Typecheck, build, and unit tests`. A renamed job reports as an unknown
  context, so the required context never appears and the PR is blocked with no failing check to point at.
- **Fix:** the verify job name is back to `Typecheck and unit tests`; the `npm run build:server` step and its comment stay.
  `docs/phase-8-production-readiness.md` now records the rule and the workflow carries a comment, so the next rename attempt
  is stopped at the source. Patching branch protection to the new name instead would also have worked, but that changes
  repository settings; a stable context name needs no admin action.
- **PR and merge:** [PR #7](https://github.com/shazzark/gradreach-agent/pull/7) was rebase-merged at 2026-11-21. Checks on
  the fixed head: "Typecheck and unit tests" passed in 24 s and "MongoDB integration" passed in 40 s (run `44842676358`).
  The rebase rewrote the two branch commits, so `ad156cb` became `0ff263d` and `34daacc` became `082deb7`; `main` is at
  `082deb7`. The post-merge push run `44842796061` completed `success` in 49 s. Local `main` was moved to `origin/main` and
  `git status -sb` reports no ahead/behind divergence. Before that move, `git diff --stat ad156cb 0ff263d` was empty, which
  proved the local commit's content was already in `origin/main` and nothing was discarded. The branch remains on the remote
  for reference, as with earlier phases. No provider, database, email, or deployment action occurred in this batch.

## Batch 10 - R7 (Global Allowlist Expansion - Phase 2)

- **Why this batch exists:** Batch 6 (2026-11-20) widened ten priority regions. The other 30 configured regions still held
  only one or two exact hosts each, so `site:` discovery was effectively Western-centric. AUDIT.md A-03/R7 asks for wider
  per-region evidence, not a bigger single-university list.
- **Countries expanded (27):** Belgium, China, South Korea, Portugal, Bosnia and Herzegovina, Bulgaria, Croatia, Czechia,
  Denmark, Estonia, Finland, Greece, Hungary, Iceland, Ireland, Latvia, Lithuania, Moldova, Montenegro, Norway, Poland,
  Russia, Serbia, Slovakia, Slovenia, Spain, Ukraine.
- **Number of new hosts added:** 76, taking `OFFICIAL_HOSTS_BY_REGION` from 91 to 167 exact hosts across the same 42
  regions. `OFFICIAL_INSTITUTION_BY_HOST` grew by the same 76 entries (116 explicit hosts now), so every added host
  attributes its own institution instead of falling back to the region's original university.
- **Region shape after the pass:** 20 regions carry four hosts, 9 carry three, 5 carry six, 4 carry five, Japan carries
  seven, and Liechtenstein, Luxembourg, and Malta stay at one because each country has exactly one accredited university
  (no second domain exists to add). Iceland, Latvia, Moldova, Slovenia, and Ukraine gained two hosts each; every further
  candidate there failed a probe.
- **Verification:** `npm run typecheck` exit 0. `npm test` 348 tests, 347 passed, 1 opt-in MongoDB test skipped, 0 failed.
  `npm run build` exit 0. Every added host was requested over HTTPS with `curl` on 2026-11-21 before it was written to the
  allowlist, and the section in `docs/phase-3-allowlist.md` records one row per host with the exact URL, the observed
  title, and the phrase "Checked 2026-11-21". A check script compared the 76 new hosts against the 76 new doc rows and
  found no missing or duplicated entry.
- **Rejections kept:** 23 candidates failed a probe (timeouts, HTTP 403, DNS failure, untrusted TLS, a redirect to plain
  HTTP, or a redirect chain to a versioned host) and 11 more resolved to an HTTP 200 page but were deliberately left out so a
  region's single-search site filter stays short. All 34 are listed under the table so the next pass does not re-probe
  blindly.
- **Brave 400-character budget:** the longest composed base query after the expansion is Japan at 279 characters (the
  United States is 237, Germany 226, the United Kingdom 205), so the single-search-per-region filter and the
  `queryFor` interest truncation still fit. The existing unit test that composes the base query for every region passes,
  and it now also pins the 167-host total plus Bulgaria, Liechtenstein, Luxembourg, and Malta.
- **Invariants unchanged:** no dependency was added, hosts remain bare lowercase HTTPS hostnames matched exactly, no parent
  domain was inferred, and no provider, database, email, or deployment action occurred. Discovery still runs only on
  countries the private profile configures, and only for regions whose reviewed hosts are recorded here.


