# GradReach — Batch 1 hand-off log

Purpose: hand-off note for the next agent. It records what was done, what was
verified, what is still open, and how to reproduce the checks. Read this together
with `AUDIT.md` (findings A-01, A-02, A-04, A-11) and `AGENTS.md`.

Privacy: this file contains no personal identifiers, credentials, email addresses,
or applicant data. Keep it that way.

## Status snapshot

| Field | Value |
|---|---|
| Branch | `main` |
| Starting HEAD | `2a20005` (`docs: refine audit citations for daily-cap enforcement`) |
| Working tree at start | Dirty: 18 modified files, 5 untracked paths (audit A-02) |
| Batch | 1 — R1, R2, R3, R9 |
| Skills applied | `engineering-workflow`, `git-engineering` (global, unmodified) |
| Verification | `npm run typecheck` exit 0 · `npm test` exit 0 (290 tests, 289 pass, 0 fail, 1 opt-in skip) · `npm run build` exit 0 |
| Remote state | Push authorized by the Batch 1 instruction; `git push origin main` is the final step of this batch |

## Phase log

| Phase | Recommendation | Commit | Result |
|---|---|---|---|
| 0 | — | — | `deepseek.md` created before any code edit |
| 1 | R1 (A-01) | `53f4fa3` | Hardcoded recipient removed; self-test fails closed without `GRADREACH_OWNER_EMAIL`; test added |
| 2 | R2a (A-02) | `9c9756c` | In-flight opportunity/provider/UI code committed (10 files) |
| 3 | R2b (A-02) | `97896cb` | In-flight tests, fixtures, adapter doc and `.gitignore` committed (13 files) |
| 4 | R3 (A-04) | `9a34787` | README status rewritten with durable facts only |
| 5 | R9 (A-11) | `74e3029` | Daily-limit constants + validator centralized in the domain layer |
| 6 | Verification | — | Typecheck, full suite and production build all exit 0 |
| 7 | Log + push | _this commit_ | Hand-off log committed; push is the final action |

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
- Acceptance: one exported validator, three independent call sites, existing
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

| Finding | Status | Evidence |
|---|---|---|
| A-01 (hardcoded recipient) | **Closed** | `sendGmailSelfTest()` resolves `GRADREACH_OWNER_EMAIL`; repo-wide scan for the address in `src/`, `app/`, `test/`, `docs/`, `README.md`, `AGENTS.md` returns no hits |
| A-02 (dirty tree) | **Closed** | In-flight work committed in two bounded commits; artifact directories ignored; only this log was untracked during the batch |
| A-04 (stale status docs) | **Closed** | `README.md` status rewritten; `npm test` counts removed |
| A-11 (triplicated daily cap) | **Closed** | One exported validator/constant set; four independent call sites still enforce it |

## Open items carried forward

- R4–R8, R10–R12 from `AUDIT.md` are untouched by Batch 1.
- Integration suite still opt-in; its guarantee rests on the test as written
  unless `npm run test:mongodb` is run against a disposable database.
- No live Brave, Gemini, Gmail, MongoDB or deployment call was made in this batch.

## Notes for the next agent

- Work in verified phases, run the checks above, inspect the diff, then commit
  with `phase-N: …` / `fix: …` / `docs: …` messages.
- Never push without explicit owner authorization.
- Never add personal data to source, docs, fixtures or this log.
