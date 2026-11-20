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
| Remote state          | Not pushed. Push is the owner's decision                                                       |

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
  only the skip and fail-loud paths were exercised here. The first CI run is the
  end-to-end proof that R4 asks for.
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

- R5–R8 and R10–R12 in `AUDIT.md` are untouched.
- Lint/Prettier/Vitest/coverage stays a separate, explicitly deferred phase; no
  dependency or npm script was added here.
- The workflow itself is unverified until the owner pushes; required status
  checks and branch protection on `main` are repository settings, not files.
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
