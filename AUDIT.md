# GradReach Agent — Repository Audit

| Field | Value |
|---|---|
| Repository | `shazzark/gradreach-agent` (local working copy `c:\Users\chido\Developer\gradreach-agent`) |
| Commit audited | `a2e2132` — *Add bounded official opportunity discovery* |
| Working tree | **Dirty** — 18 modified files (+350/−142) and 5 untracked paths |
| Audit date | 2026-11-19 |
| Method | Static read of all tracked source, tests, configs and docs; `npm test`; `npm run typecheck`; git state inspection. No live Brave, Gemini, Gmail, MongoDB or deployment call was made during this audit. |
| Verdict | **Strong engineering discipline; product objective not met.** The delivery, approval and access-control core is genuinely well built and well tested. The 200-professor research goal is not close to achieved, outbound sending is not operated anywhere, reply tracking is manual, and three hygiene defects (a hardcoded personal email in source, a dirty tree, status docs that disagree with measured facts) block a clean release. |

---

## 1. Executive summary

GradReach is a private, owner-only web application plus a set of CLI workers that
(a) discover professors and programs through Brave Search and official-page
fetches, (b) assess program facts conservatively, (c) generate source-cited
drafts, and (d) plan and — when explicitly enabled — send at most five Gmail
messages per local calendar day.

What the code actually delivers:

- **A verified build.** `npm run typecheck` exits `0`. `npm test` exits `0` with
  **289 tests, 288 pass, 0 fail, 1 skipped** in 28.9 s (`node --experimental-strip-types --test`).
- **A correct, triple-enforced daily cap.** The cap is validated in three
  independent places: planner (`src/application/daily-outreach-planner.ts:17-18`),
  domain selection (`src/domain/outreach-queue.ts:167-169`), and an atomic
  per-local-day reservation in MongoDB (`src/infrastructure/mongo-storage.ts:696`),
  exercised by `test/mongo-storage.integration.test.ts:144-146` (five reservations
  succeed, the sixth fails, the next day succeeds).
- **Approval integrity.** A SHA-256 fingerprint of the approved draft is stored
  at approval time (`src/application/outreach-review.ts:54`) and re-checked
  immediately before send (`src/infrastructure/gmail-oauth.ts:355`), with
  recipient and contact re-validation at `:356-357`.
- **Safe failure semantics.** Uncertain provider outcomes are recorded as
  `uncertain` and never auto-resent; only `not-sent` + retryable failures retry,
  capped at 3 attempts with exponential backoff (`gmail-oauth.ts:276, 325-335`).
- **Deny-by-default access control.** `auth.ts:33-41` returns `false` for anything
  not public and not an owner session; `src/web/owner-access.ts:53-64` requires a
  Google-verified email equal to `GRADREACH_OWNER_EMAIL`; `:21-41` closes the
  open-redirect hole in the post-login return path.

What the code does **not** deliver, measured against the stated product goal
(200 researched professors and programs, verified admissions/GPA/funding/
English/contact data, five personalized emails per day, tracked replies):

1. **The 200-professor pool does not exist.** Discovery is capped at
   `DISCOVERY_LIMITS = { searchesPerRun: 1, resultsPerSearch: 3, inspectionsPerRun: 5 }`
   (`src/application/automatic-discovery.ts:99`). The most recent documented live
   run (README.md:7) made 26 requests, hit HTTP 422 on 15 of them, and **saved zero
   leads that passed all checks**.
2. **Sending is implemented but not operated.** The scheduler refuses to start
   without `OUTREACH_SENDING_ENABLED=true` (`src/interfaces/outreach-scheduler.ts:10-13`)
   and nothing is deployed (`docs/private-website-deployment.md:5, 54`).
3. **Replies are manual.** The granted Gmail scope is `gmail.send` only
   (`src/infrastructure/gmail-oauth.ts:14`); `docs/implementation-plan.md:116`
   states the app "cannot read replies", and the stored status is "manually
   recorded" (`:177`).
4. **The programme-verification layer has no live data.** Assessment logic exists
   and is tested, but no populated programme corpus is in the repo; transcripts are
   stored only as a file path (`src/domain/applicant-profile.ts:38`) and nothing
   parses them, and GPA/currency conversion is deliberately refused
   (`docs/implementation-plan.md:82`).

Three defects prevent a clean hand-off: a **personal Gmail address hardcoded in
source** (`src/infrastructure/gmail-oauth.ts:211`) in direct violation of the
project's own privacy rule in `AGENTS.md`; a **dirty working tree** with
uncommitted storage, migration and provider work; and **status documentation that
is stale or misleading** (README claims 186 tests where 289 run, and "no email was
sent" while `private-data/gmail-self-test-audit.json` records a delivered Gmail
message on 2026-11-11).

---

## 2. Scope, method and reproducible evidence

### 2.1 What was inspected

All 172 tracked files plus the untracked working-tree additions were enumerated
with `git ls-files` and measured line-by-line with
`Get-Content <file> | Measure-Object -Line`. Every source file in `src/domain`,
`src/application`, `src/infrastructure`, `src/web`, `src/interfaces`, `app/`,
plus `auth.ts`, `proxy.ts`, `next.config.ts`, `package.json`, `README.md`,
`.env.example`, `.gitignore` and `docs/*` was read in full or in the relevant
region.

### 2.2 Commands executed during the audit

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **exit 0** | `%TEMP%\gr-tc-exit.txt` → `TYPECHECK_EXIT=0` |
| `npm test` (`node --experimental-strip-types --test`) | **exit 0**, `# tests 289 / # pass 288 / # fail 0 / # cancelled 0 / # skipped 1 / # todo 0 / # duration_ms 28855.6` | `%TEMP%\gr-test.txt`, summary in `%TEMP%\gr-summary.txt` |
| `git log --oneline -5` | HEAD `a2e2132` | `%TEMP%\gr-inventory.txt` |
| `git status --porcelain` | 18 `M`, 5 `??` | `%TEMP%\gr-inventory.txt` |
| `git diff --stat` | `18 files changed, 350 insertions(+), 142 deletions(-)` | `%TEMP%\gr-diffstat.txt` |
| Scan `TODO|FIXME|HACK|XXX:` | 0 real markers (only a local variable named `todo`, `src/interfaces/enrich-confirmed-professors.ts:99-103`) | every `.ts`/`.tsx`/`.md`/`.json` file in the working tree |
| Scan `@ts-ignore|@ts-expect-error|eslint-disable` | **0 results** | same scope |
| Scan for the owner's address | 1 source hit + 3 hits in one private audit file | `src/infrastructure/gmail-oauth.ts:211` |

### 2.3 Explicit limitations of this audit

These are **not** verified here and must not be reported as proven:

- No live Brave Search, Gemini, Gmail or MongoDB call was made.
- `npm run build` (`next build`) was **not** executed; only `tsc --noEmit` was.
- The opt-in integration suite (`npm run test:mongodb`) was **not** re-run; its
  skip is the single skipped test. The atomic send-reservation guarantee
  therefore rests on `test/mongo-storage.integration.test.ts` as written, not on
  a run performed during this audit.
- No deployment exists (`docs/private-website-deployment.md:5`), so hosting,
  OAuth-consent and WebSocket-proxy behaviour are unverified in production.
- Delivery of the single live Gmail self-test is inferred from
  `private-data/gmail-self-test-audit.json`, not from a mailbox check.

---

## 3. Architecture and inventory

### 3.1 Layering (as implemented)

The repository follows a clean four-layer split with a Next.js presentation shell
on top. Counts are **non-blank** lines (`Get-Content … | Measure-Object -Line`,
which ignores empty lines); citations elsewhere use absolute line numbers from the
file itself.

| Layer | Location | Files | Lines | Responsibility |
|---|---|---|---|---|
| Domain | `src/domain/` | 10 | 1,057 | Pure types and rules: `outreach-queue.ts`, `program-assessment.ts`, `applicant-profile.ts`, `job-progress.ts`, `opportunity-discovery.ts`, `saved-lead-reprocessing.ts`, `discovery-scheduling.ts`, `discovery-country-coverage.ts`, `professor-research-evidence.ts`, `research-interest-match.ts` |
| Application | `src/application/` | 18 | 3,808 | Use cases: `research-discovery.ts` (1,013), `automatic-discovery.ts` (480), `confirmed-professor-research-enrichment.ts` (325), `confirmed-professors.ts` (317), `evidence-triage.ts` (294), `opportunity-discovery.ts` (280), `reprocess-saved-professor-leads.ts` (262), `outreach-draft.ts` (228), `professor-research-evidence.ts` (152), plus `daily-outreach-planner`, `outreach-review`, `dashboard`, `profile-preferences`, `country-lead-browser`, `candidate-review-preview`, `discovery-lead-review`, `discovery-preview-continuation`, `replay-preview-evidence` |
| Infrastructure | `src/infrastructure/` | 13 | 2,379 | Adapters: `mongo-storage.ts` (748), `sanitized-failure.ts` (456), `gmail-oauth.ts` (348), `phase3-pilot-diagnostics.ts` (277), `brave-search-provider.ts` (175), `gemini-draft-provider.ts` (110), `discovery-collection-migration.ts`, `opportunity-collection-migration.ts` (untracked), `local-env.ts`, `local-profile.ts`, `job-progress-bus.ts`, `socket-progress-server.ts`, `create-indexes.ts` |
| Web helpers | `src/web/` | 16 | 970 | `owner-workflows.ts` (210), `confirmed-professors-data.ts` (126), `owner-access.ts` (76), plus client components (`lead-browser.tsx`, `workspace-navigation-client.tsx`, `job-progress-client.tsx`, `research-preferences-editor.tsx`) and the `owner-*` loaders/gateways |
| CLI interfaces | `src/interfaces/` | 21 | 2,504 | 21 files backing 25 npm scripts (`dev` and `web` both use `web-server.ts`), e.g. `terminal-app.ts` (297), `web-server.ts` (53) |
| Config | `src/config/` | 2 | 94 | `official-host-allowlist.ts` (42 regions, 51 hostnames), `official-opportunity-hosts.ts` |
| Next.js App Router | `app/` | 21 | ~876 | Owner route group, server actions, auth route, manifest/icons |
| Tests | `test/` | 45 test files (44 tracked + 1 new) | 6,240 | `node:test` + `node:assert/strict`, 3 JSON fixtures, 1 helper |

The layering is honest: no file in `src/domain` imports from `src/infrastructure`
or `src/web`, and infrastructure adapters are injected into application functions
rather than imported by them.

### 3.2 Runtime topology

Three independent processes share one MongoDB database:

1. **Web server** — `src/interfaces/web-server.ts:12-51`: a custom `node:http`
   server that mounts the Next.js request handler and attaches Socket.IO on
   `/api/socket.io` (`:22-27`, `maxHttpBufferSize: 1024`, 25 s ping / 20 s
   timeout). This is why the app cannot run as a serverless deployment
   (`docs/private-website-deployment.md:21`).
2. **Outreach scheduler** — `src/interfaces/outreach-scheduler.ts:9-37`: 60 s
   poll (`:7`), one `deliverNext()` claim per tick (`:25`), graceful
   `SIGINT`/`SIGTERM` shutdown (`:20-21, 32-36`), hard gate on
   `OUTREACH_SENDING_ENABLED === 'true'` (`:10-13`).
3. **Discovery scheduler** — `src/interfaces/discovery-scheduler.ts` (76 lines),
   driven by `DiscoverySchedule` with `sweepOnce` finite sweeps
   (`src/application/automatic-discovery.ts:22-32`); default
   `{ enabled: false, paused: true, frequency: 'weekly' }` (`:96-98`).

### 3.3 Persistence

`src/infrastructure/mongo-storage.ts` (748 lines) is the single storage adapter and
carries the strongest correctness guarantee in the codebase: a startup migration
guard that refuses to serve while legacy collection names exist
(`discovery_leads` / `lead_triage_recommendations`, README.md:25), plus
`claimForDelivery`, `recoverStaleSending`, `updateDelivery`, `markSent` and
`reserveDailySend` (`:696`). A second, still-uncommitted
`opportunity-collection-migration.ts` (98 lines) applies the same pattern to
opportunities.

### 3.4 Dependencies and tooling gaps

Runtime: `next ^16.4.3`, `next-auth ^5.0.0-beta.32`, `mongodb ^7.7.0`,
`socket.io ^4.8.4`, `socket.io-client ^4.8.4`, `react`/`react-dom ^19.3.1`.
Tooling: `typescript ^5.8.3`, `tailwindcss ^4.3.3`, `@tailwindcss/postcss`,
`@types/node ^22`. `engines.node >= 22` (`package.json:8`).

Two consequences:

- Every server-side script runs through `--experimental-strip-types`
  (`package.json:11-41`). There is no compile step for the Node core, so runtime
  behaviour depends on a flag Node may still change.
- There is **no test framework, linter, formatter or CI** in the repository: no
  Vitest, no ESLint, no Prettier, and no workflow file in `git ls-files`. The only
  gates are `npm run typecheck` and `npm run build` (`package.json:34-35`), both
  manual.

### 3.5 Request path for a website action

`browser → proxy.ts (auth matcher) → app/(owner)/*/page.tsx → app/actions.ts → withOwnerData → src/web/owner-workflows.ts → src/application/* → src/infrastructure/*`

`proxy.ts:1-5` re-exports `auth` as `proxy` over every path except `_next/static`,
`_next/image`, `favicon.ico` and `robots.txt`; `withOwnerData` re-checks the owner
session server-side, so the middleware is defence-in-depth rather than the only
control (README.md:56).

---

## 4. Subsystem status matrix

Legend — **Verified**: code plus automated tests exist and the tests pass in this
audit. **Unoperated**: code exists and is gated, but nothing runs it in
production. **Partial**: part of the promised behaviour is manual or missing.
**WIP**: present in the working tree but uncommitted. **Absent**: no code.

### 4.1 Identity, access and UI

| Capability | State | Evidence | Note |
|---|---|---|---|
| Google OIDC owner sign-in | Verified | `auth.ts:7-42`; scopes `openid email profile` only (`src/web/owner-access.ts:13`); `test/owner-access.test.ts`, `test/auth-local-origin.test.ts` | No account creation: sign-in requires `email_verified === true` and an exact email match (`owner-access.ts:53-64`) |
| Session hardening | Verified | `auth.ts:10` (JWT, 8 h max age), `:17-32` | Owner flag is recomputed on every jwt/session callback, not trusted from the stored token |
| Route + action protection | Verified | `proxy.ts:1-5`; `auth.ts:33-41`; `withOwnerData` in `app/actions.ts`; `test/website-navigation-and-data.test.ts` | APIs receive `401` JSON; pages redirect to `/sign-in` |
| Open-redirect protection | Verified | `src/web/owner-access.ts:21-41` | Rejects `//`, backslashes, credentials, `/sign-in`, `/api/auth` |
| Workspace pages | Verified | `app/(owner)/{workspace,discovery,leads,confirmed-professors,drafts,outreach,programs,profile}/page.tsx` + `layout.tsx`, `error.tsx`, `loading.tsx` | 8 owner pages behind one layout |
| Public welcome page | Verified | `app/page.tsx`; `test/public-welcome-page.test.ts` | Contains no applicant or database data |
| Server actions | Verified | `app/actions.ts` (335 lines): discovery run, evidence triage, draft generation, approval, queue planning, pause toggle, profile edits | `test/owner-workflows.test.ts` covers the workflow layer |
| Progress streaming | Verified | `web-server.ts:22-32`, `socket-progress-server.ts`, `socket-progress-auth.ts`, `test/job-progress.test.ts` | Handshake requires an owner token, a trusted origin and a signature |
| Security headers | Verified | `next.config.ts:8-20` | `no-store`, `nosniff`, `DENY` framing, `no-referrer`, HSTS, `poweredByHeader: false` |
| Custom server + WebSocket proxy | Unoperated | `web-server.ts`, `docs/private-website-deployment.md:21, 44` | Needs a host supporting WebSocket upgrades; no host exists |

### 4.2 Research and discovery

| Capability | State | Evidence | Note |
|---|---|---|---|
| Single discovery run (search → fetch → identity → evidence) | Verified, throughput-limited | `src/application/research-discovery.ts` (1,013 lines), `src/application/automatic-discovery.ts`; `test/discovery-runner.test.ts`, `test/research-discovery.test.ts` (1,367 lines) | Hard caps: 1 search, 3 results, 5 inspections per run (`automatic-discovery.ts:99`) |
| Region coverage | Partial | `src/config/official-host-allowlist.ts:2-53` — 42 countries, 51 hostnames; 39 countries map to exactly **one** host | Every professor must sit on one of 51 allowlisted hosts |
| Exact-host / HTTPS evidence policy | Verified | `confirmed-professor-research-enrichment.ts:323-324`; `outreach-draft.ts:145-152` | Professors on any other institution domain are rejected structurally |
| Discovery scheduling | Verified, disabled by default | `automatic-discovery.ts:96-112`, `src/domain/discovery-scheduling.ts`, `src/interfaces/discovery-scheduler.ts`; `test/discovery-runner.test.ts` | `enabled: false, paused: true`; maximum 45 configured countries (`:108`) |
| Run history + diagnostics | Verified | `DiscoveryRun` / `DiscoveryResultDiagnostic` (`automatic-discovery.ts:44-94`); `src/infrastructure/phase3-pilot-diagnostics.ts`; `test/phase3-pilot-diagnostics.test.ts` | Diagnostics are bounded and content-free |
| Lead review / acceptance | Verified | `src/application/discovery-lead-review.ts`, `src/application/country-lead-browser.ts`; `test/discovery-lead-review.test.ts` | Human discovery decision stored separately from triage and send state (`outreach-queue.ts:31-32`) |
| Evidence triage (Gemini) | Verified, advisory | `src/application/evidence-triage.ts`, `src/infrastructure/gemini-draft-provider.ts`; `test/evidence-triage.test.ts` | Cannot approve a lead; owner-triggered only |
| Professor research enrichment | Verified | `src/application/confirmed-professor-research-enrichment.ts`; dedicated test | Bounded batch page-fetch budget; duplicate-URL and duplicate-person collapsing |
| Confirmed-professor decisions | Verified | `src/application/confirmed-professors.ts`; dedicated test | Requires official-profile attribution |
| Saved-lead reprocessing | Verified | `src/application/reprocess-saved-professor-leads.ts`; `test/saved-lead-reprocessing.test.ts` | Skips any candidate with a discovery review or approval (`:184-185`), so approval, draft hash and review state are preserved by construction |
| Opportunity discovery (scholarships, companies) | **WIP** | untracked `opportunity-collection-migration.ts`, `docs/search-provider-adapters.md`, `test/search-provider-contract.test.ts`; committed `opportunity-discovery.ts`, `official-opportunity-hosts.ts:12-14` | Uncommitted work in flight — finding A-02 |

### 4.3 Assessment, drafting and outreach

| Capability | State | Evidence | Note |
|---|---|---|---|
| Program assessment (eligibility, cost, English, funding) | Verified logic, **no live corpus** | `src/domain/program-assessment.ts` (372 lines); `test/program-assessment.test.ts` (171 lines) | GPA/currency conversion deliberately refused; unverified facts stay `unclear` |
| Transcript parsing | **Absent** | `src/domain/applicant-profile.ts:38` stores a `transcriptPath` only; no parser module exists in `src/` | Explicitly out of scope today — GPA is entered by the owner, never derived |
| Profile + preference editing | Verified | `src/domain/applicant-profile.ts`, `src/application/profile-preferences.ts`, `src/web/research-preferences-editor.tsx`; two dedicated tests | Profile still loaded from a private local JSON file |
| Draft generation | Verified | `src/application/outreach-draft.ts`, `src/infrastructure/gemini-draft-provider.ts`; `test/outreach-draft.test.ts` | Deterministic source-cited template plus optional Gemini; every draft must cite an official-host URL |
| Draft approval | Verified | `src/application/outreach-review.ts:54`; `test/outreach-review.test.ts`, `test/owner-workflows.test.ts:157-161` | `approvedDraftHash` is a 64-hex SHA-256 of the exact draft |
| Queue planning + daily cap | Verified | `src/domain/outreach-queue.ts:160-202`, `src/application/daily-outreach-planner.ts:11-52`; two dedicated tests | Cap ≤ 5 is an invariant, not a preference |
| Pause control | Verified | `SchedulerControl.paused` (`outreach-queue.ts:89-93`); `daily-outreach-planner.ts:21-33`; `gmail-oauth.ts:291` | Blocks new claims; an in-flight send may finish |
| Dashboard / status readout | Verified | `src/application/dashboard.ts`, `src/web/outreach-runtime-status.ts`; two dedicated tests | Capacity is reported in the owner's timezone |
| Gmail OAuth connect | Verified | `gmail-oauth.ts` (PKCE + state + loopback), `npm run gmail:connect`; `test/provider-integrations.test.ts` | Scope `gmail.send` only; token in ignored `private-data/` |
| Delivery worker (5/day) | Verified logic, **unoperated** | `GmailDeliveryService.deliverNext` (`gmail-oauth.ts:285-341`), `reserveDailySend` (`mongo-storage.ts:696`), `test/outreach-delivery.test.ts` (249 lines) | Refuses to run without `OUTREACH_SENDING_ENABLED=true`; not deployed |
| Reply + follow-up tracking | **Partial (manual)** | `OutreachAttempt.replyStatus` / `followUpStatus` (`outreach-queue.ts:83-86`); `docs/implementation-plan.md:177` | No reply ingestion: the granted Gmail scope is send-only |
| Blocking bad sends | Verified | `gmail-oauth.ts:343-357`; `candidateReadinessIssue` (`outreach-queue.ts:125-140`) | Rejects missing approval, changed draft, recipient mismatch, missing evidence, non-HTTPS sources |

### 4.4 Platform

| Capability | State | Evidence | Note |
|---|---|---|---|
| Storage, indexes, migration guard | Verified (opt-in test) | `mongo-storage.ts`, `create-indexes.ts`, `discovery-collection-migration.ts`; `test/mongo-storage.integration.test.ts` (354 lines, skipped without `MONGODB_TEST_URI`) | Legacy collection names block startup |
| Sanitized failure reporting | Verified | `src/infrastructure/sanitized-failure.ts` (456 lines); `test/provider-integrations.test.ts` | Raw provider text is not retained |
| CLI tooling | Verified | 31 npm scripts (`package.json:11-41`), 25 of them `src/interfaces` entry points | Several are single-purpose scripts, e.g. `leads:draft-preview:candidate-03` |
| CI, lint, formatting | **Absent** | no workflow file in `git ls-files`; no ESLint/Prettier/Vitest dependency | Only manual `typecheck` / `build` |
| Deployment | **Absent (drafted)** | `docs/private-website-deployment.md` (65 lines), `next.config.ts:7` | Documented in full, executed nowhere |

**Tally:** 38 capabilities assessed — **30 verified** (two of those verified only
with an opt-in MongoDB test, and one verified in logic but with no live programme
corpus), **2 implemented but unoperated** (delivery worker, region breadth in
practice), **2 partial** (reply tracking, transcript/GPA coverage), **1 WIP**
(opportunity discovery), **3 absent** (transcript parsing, CI/lint, deployment).

---

## 5. Findings

Severity: **High** = blocks release / violates a stated rule; **Medium** = material
risk or goal gap; **Low** = maintainability or hygiene.

### A-01 · High · A personal Gmail address is hardcoded in source

`src/infrastructure/gmail-oauth.ts:211`

```ts
const recipient = '<owner-address>';
```

(The literal address is redacted in this document. It remains present in the
earlier audit commit `7b56706` and in the pre-fix source history; removing it
from history requires a separate, owner-authorized rewrite.)

`AGENTS.md` states: *"Do not hard-code user-specific profile data into source
code or public planning documents."* This is exactly that. The same string also
appears three times in `private-data/gmail-self-test-audit.json` (correctly
git-ignored, `.gitignore:11`), so the value is already present in the local
private tree as data.

Impact: the self-test is unusable by any other operator, the owner's address is
baked into repository history, and the privacy rule is demonstrably not enforced
by review.

Fix: resolve the recipient from `GRADREACH_OWNER_EMAIL` (or the loaded private
profile's contact email) and fail closed with a clear error when unset. Refer to
the address generically in docs.

### A-02 · High · The working tree is dirty, including the safest-looking code

HEAD is `a2e2132`; `git status --porcelain` reports **18 modified files**
(`+350 / −142`) and **5 untracked paths**:

```
M  src/infrastructure/mongo-storage.ts          +94/−60
M  test/mongo-storage.integration.test.ts       +81/−10
M  src/infrastructure/brave-search-provider.ts  +40/−3
M  src/domain/program-assessment.ts             +36/−8
M  src/infrastructure/gmail-oauth.ts            +24/−15
   …13 more modified files                      +75/−46
?? src/infrastructure/opportunity-collection-migration.ts
?? docs/search-provider-adapters.md
?? test/search-provider-contract.test.ts
?? test/fixtures/search-provider/
?? .playwright-mcp/
```

(A sixth untracked path, `AUDIT.md`, is created by this audit.)

Impact: the storage adapter that carries the daily-cap and claim invariants, plus
the Gmail adapter that performs sends, are **uncommitted**. A crash or an
accidental `git checkout` loses audited work. `.playwright-mcp/` is an untracked
browser-automation artifact directory that should be ignored rather than shipped
into `git status` noise.

Fix: commit the opportunity/provider work in two bounded commits (code, then
docs+tests), and add `.playwright-mcp/` to `.gitignore`. This is required by the
repository's own Git policy.

### A-03 · High · The 200-professor objective is unreachable at current throughput

The pipeline itself is sound, but three configured limits bound it hard:

| Limit | Value | Location |
|---|---|---|
| Searches per run | **1** | `src/application/automatic-discovery.ts:99` |
| Results per search | **3** | same |
| Inspections per run | **5** | same |
| Schedule default | `enabled: false, paused: true`, weekly | `:96-98` |
| Allowlisted countries | 42 | `src/config/official-host-allowlist.ts:2-53` |
| Allowlisted hostnames | 51 (39 countries have exactly one) | same |

A perfect sweep inspects 5 pages. Reaching 200 saved professors therefore needs
**at least 40 fully successful sweeps**, and the one documented live run
(README.md:7) converted 26 search requests into 15 HTTP 422 responses and **zero**
fully qualified leads — a 58 % request-failure rate that multiplies the run count
to the hundreds.

This is not a bug in the code; it is a mismatch between the configured operating
envelope and the stated goal. Either the limits must rise with a documented
provider budget, or the goal must be restated in phases (e.g. 20 professors per
region pass) with evidence of the failure rate being fixed first.

### A-04 · Medium · Status documentation contradicts measured facts

| Claim | Source | Measured |
|---|---|---|
| "`npm test` passed (186 passed, one opt-in MongoDB test skipped)" | `README.md:7` | 289 tests, 288 pass, 1 skipped |
| "no email was sent" | `README.md:7` | `private-data/gmail-self-test-audit.json` records `"status":"delivered"` with `providerMessageId 1a1cc2879ba2ba29` on 2026-11-11T19:49:25Z, after two `gmail-auth-unavailable` failures |

The "no email was sent" sentence is defensible only in the narrow sense of *no
professor outreach*, but a reader — or an automated agent following `AGENTS.md`
("never claim a live integration works until tested") — will read it as *the
provider was never exercised*, which is false.

Impact: a stale number is a trust defect in a project whose value proposition is
truthfulness and source evidence.

Fix: remove volatile counts from `README.md` and point to
`docs/implementation-plan.md`; state the self-test outcome explicitly.

### A-05 · Medium · Reply and follow-up tracking is manual, by design

`src/domain/outreach-queue.ts:83-86` models `replyStatus`
(`replied | no-response | declined`) and `followUpStatus`
(`not-planned | due | scheduled | sent | closed`), and the website/terminal app let
the owner record them by hand. Nothing reads Gmail replies: the granted scope is
`https://www.googleapis.com/auth/gmail.send` (`src/infrastructure/gmail-oauth.ts:14`)
and `docs/implementation-plan.md:116` states "so it cannot read replies"; the data
model describes reply status as "manually recorded" (`:177`).

Impact: the product goal includes "track replies and follow-ups". Meeting it
requires a *separate*, explicitly justified consent for read access (typically
`gmail.readonly` restricted scope, or a different mailbox), a retention design,
and a prompt-injection stance for untrusted email bodies. That work is not
started. Until then the goal should be described as *manually recorded reply
status*, not *reply tracking*.

### A-06 · Medium · Outbound sending has no supervised runtime

`src/interfaces/outreach-scheduler.ts` is a 60 s poll loop that must run as a
persistent local process; `docs/private-website-deployment.md:54` forbids
deploying it as a web function and says any production sender "needs its own
approved hosting and secure Gmail-token design". Nothing in the repository
provides supervision (systemd unit, Windows Scheduled Task, PM2 config), a
heartbeat, or an alert when the loop dies.

Impact: the five-per-day promise is only kept while a human keeps a terminal
open. Silent death of the worker looks identical to "no draft was due".

Fix: add a documented supervision recipe plus a `lastHeartbeatAt` field written
by every loop iteration and surfaced in `src/web/outreach-runtime-status.ts`.

### A-07 · Medium · No CI, no lint, no coverage; one test file dominates the suite

There is no workflow file in `git ls-files`, and `package.json` has no ESLint,
Prettier, Vitest or coverage dependency. The only gates are `typecheck` and
`build` (`package.json:34-35`), both manual and both bypassable.

`test/research-discovery.test.ts` is **1,367 non-blank lines — 22 % of the
6,240 non-blank lines in `test/`** — while the atomic delivery guarantees live in a
test that is skipped by default (A-08). That is an inverted test portfolio: the
highest-risk code has the least continuously executed coverage.

### A-08 · Medium · The integration safety net is skipped in a default run

`npm test` reports `# skipped 1`. That one skip is
`test/mongo-storage.integration.test.ts` (354 lines), which is the only executable
proof of `reserveDailySend` (`mongo-storage.ts:696`), `claimForDelivery`,
`recoverStaleSending` and the legacy-collection startup guard. It only runs with
`npm run test:mongodb` and a `MONGODB_TEST_URI` that parses to exactly
`gradreach_test` (README.md:21, `test/mongo-test-uri.test.ts`).

Impact: in the audited run, the five-per-day cap is verified by unit tests and
mocks only. The database-level atomicity claim was not exercised.

Fix: run `npm run test:mongodb` in a containerized CI job against a disposable
MongoDB service before any release, and record the result in the phase plan.

### A-09 · Low · Every runtime path depends on `--experimental-strip-types`

`package.json:11-41` runs every server-side script through
`node --experimental-strip-types` (25 `src/interfaces` entry points plus one
`src/infrastructure` script). There is no `tsc` emit target and `outDir` is not
used, so `npm start` runs TypeScript directly through an experimental flag on
Node ≥ 22 (`package.json:8`).

Impact: Node has changed type-stripping semantics before and warns on every run
(the test log contains repeated `ExperimentalWarning: Type Stripping is an
experimental feature` lines). A Node upgrade can break production starts without
any code change.

Fix: either adopt a real build step for the server core, or pin the Node major and
add a startup assertion that the flag exists.

### A-10 · Low · Exploration scripts are shipping as first-class product commands

`package.json:30,32` expose `leads:review-preview:candidate-03` and
`leads:draft-preview:candidate-03`; `src/application/candidate-review-preview.ts:23`
hardcodes the `Canada` allowlist. `src/interfaces/preview-candidate-03-draft.ts`
(133 lines) is a single-candidate script with a dedicated test.

Impact: 31 npm scripts now mix durable operations (`db:*`, `gmail:*`,
`outreach:scheduler`) with one-off investigation helpers. New operators cannot
tell which is which, and the Canada hardcoding contradicts the "search every
configured region" rule if copied.

Fix: group them (`ops:*` vs `debug:*`) and derive the region from input rather
than the constant.

### A-11 · Low · The daily cap is validated in three places that can drift

`src/application/daily-outreach-planner.ts:17-18` and
`src/domain/outreach-queue.ts:167-169` each restate the range 1..5 *and* the same
error string `'dailyLimit must be an integer from 1 to 5'`, while
`reserveDailySend` (`mongo-storage.ts:696`) independently re-reads the stored
control before allowing a reservation.

Impact: duplication is *good* for defence in depth but *bad* for drift — a future
change to the allowed range must be made in two validators plus the storage
reservation path.

Fix: export `MIN_DAILY_LIMIT`, `MAX_DAILY_LIMIT` and a single validator from
`src/domain/outreach-queue.ts`, and keep the independent *checks* (call sites) as
they are.

### A-12 · Low · Type-level traps around legacy lead shape

`ProfessorCandidate.name` is documented as "Saved page or lead title; it is not a
professor identity" (`outreach-queue.ts:12-13`), with the real person in the
optional `professorName`. Consumers must remember this. Likewise
`daily-outreach-planner.ts:47` uses a non-null assertion
(`candidate.officialEmail!`) that is only safe because the selection step already
ran `candidateReadinessIssue`. Both are correct today and fragile tomorrow.

Fix: give the planner a narrow `ReadyCandidate` type produced by the readiness
check, so the assertion disappears instead of being trusted.

---

## 6. Recommendations

Ordered by risk reduction per unit of effort. Effort is a rough engineer-day
estimate for a single developer.

| # | Action | Addresses | Effort | Acceptance criteria |
|---|---|---|---|---|
| R1 | Remove the hardcoded recipient; read the self-test address from `GRADREACH_OWNER_EMAIL` (or the private profile) and fail closed when unset | A-01 | 0.5 d | No personal identifier remains in `src/`; `npm run gmail:self-test` errors clearly with no owner address configured; `test/provider-integrations.test.ts` covers the missing-config case |
| R2 | Commit the in-flight work in bounded commits and ignore `.playwright-mcp/` | A-02 | 0.5 d | `git status --porcelain` is empty after commit; two reviewable commits (`opportunity` code, then docs+tests); `.gitignore` covers the artifact dir |
| R3 | Rewrite the README status section to state only durable facts, and record the real self-test outcome | A-04 | 0.5 d | No test counts in `README.md`; a dated line states "one self-test message delivered to the owner's own address on 2026-11-11; no professor outreach sent" |
| R4 | Add a CI workflow running `npm ci && npm run typecheck && npm test`, plus a second job that starts a disposable MongoDB and runs `npm run test:mongodb` | A-07, A-08 | 1–2 d | Both jobs green on a PR; the integration job is the only place `MONGODB_TEST_URI` is set |
| R5 | Decide and document the discovery operating envelope: either raise `DISCOVERY_LIMITS` with a provider-budget rationale, or publish a phased professor target per region | A-03 | 0.5 d (decision) + build | `docs/implementation-plan.md` contains a table: regions × runs × expected saves, and the plan is reflected in `DISCOVERY_LIMITS` |
| R6 | Diagnose the 15/26 HTTP 422 rate with `npm run discovery:preflight` and surface provider health in the workspace | A-03 | 1 d | Preflight output captured in a dated doc; UI shows provider status instead of failing silently inside a run |
| R7 | Widen the allowlist per region to 2–3 verified institutions where evidence exists, keeping the exact-host rule | A-03 | 2–3 d | Each added host has a `docs/phase-3-allowlist.md` entry with the checked URL and date; professor-pool ceiling rises accordingly |
| R8 | Add worker supervision + heartbeat for `outreach:scheduler` and surface it in `outreach-runtime-status.ts` | A-06 | 1 d | A documented recipe for Windows Task Scheduler/systemd; a stale heartbeat renders as "worker not running" on `/outreach` |
| R9 | Centralize the daily-limit constants and validator in the domain layer | A-11 | 0.25 d | One exported validator, three independent call sites, tests unchanged and still green |
| R10 | Split one-off exploration scripts from durable operations (`ops:*` vs `debug:*`) and remove the `Canada` hardcode | A-10 | 0.5 d | `package.json` script names communicate intent; `candidate-review-preview.ts` takes a region argument |
| R11 | Decide the reply-tracking design before promising it: separate read-only consent, retention policy, untrusted-content handling | A-05 | research spike | A written decision record; the README states "reply status is recorded manually" until the design is approved |
| R12 | Replace `--experimental-strip-types` for production or pin Node and assert the flag at startup | A-09 | 1 d | `npm start` either runs compiled output or fails loudly on an unsupported Node |

### Suggested commit sequence

Following the repository's Git policy (`phase-N: …` / `fix: …`):

1. `fix: resolve gmail self-test recipient from configuration` (R1)
2. `phase-8: commit opportunity discovery and search provider adapters` (R2)
3. `docs: correct status claims and remove volatile test counts` (R3)
4. `phase-9: add CI with unit and mongodb integration jobs` (R4)
5. `phase-10: document and widen discovery operating envelope` (R5–R7)
6. `phase-11: supervise outreach worker with heartbeat status` (R8)
7. `refactor: centralize daily send limit invariants` (R9)
8. `refactor: separate operator and debug commands` (R10)

Push remains the owner's decision; nothing in this audit authorises a push.

---

## Appendix A · Goal-to-evidence scorecard

Every requirement in `AGENTS.md`'s "Product goal" and "Privacy and truthfulness"
sections, checked against code.

| Requirement | Verdict | Evidence |
|---|---|---|
| Research a pool of 200 relevant professors and programs | **Not met** | `automatic-discovery.ts:99` caps a run at 1 search / 3 results / 5 inspections; README.md:7 records 0 qualified saves from the last live run |
| Verify admissions, GPA/degree classification, funding, English, contact details from official sources | **Partial** | `program-assessment.ts` plus `src/application/outreach-draft.ts:145-152` (https + exact-host check on both evidence URLs) enforce source validity; no populated programme corpus exists; GPA conversion deliberately refused |
| Preserve source URL + date checked for every claim | **Met** | `sourceCheckedAt`, `emailSourceUrl`, `eligibilitySourceUrl`, `fundingSourceUrl` on the candidate (`outreach-queue.ts:22-29`); `retrievedAt`/`checkedAt` on evidence (`:43-53`) |
| Prepare and send up to five personalized emails per day | **Implemented, not operated** | `selectDailyOutreachBatch` (`outreach-queue.ts:160-202`), `reserveDailySend` (`mongo-storage.ts:696`), `deliverNext` (`gmail-oauth.ts:285-341`); gated by `OUTREACH_SENDING_ENABLED` and not deployed |
| Never more than five in the owner's timezone on a calendar day | **Met in code** | `dateKeyFor` uses `Intl.DateTimeFormat` with the configured IANA zone (`outreach-queue.ts:142-157`); atomic reservation counts per local day (`mongo-storage.ts:696`); integration test proves the 6th reservation fails (`test/mongo-storage.integration.test.ts:144-146`) |
| Audit log of sends | **Met** | `OutreachAttempt` fields (`outreach-queue.ts:72-87`) plus `private-data/gmail-self-test-audit.json` for the self-test |
| Pause control | **Met** | `SchedulerControl.paused` (`:89-93`) enforced in planner, delivery and `reserveDailySend` |
| Track replies and follow-ups | **Partial — manual** | Status fields exist (`:83-86`); no read scope, no ingestion (`docs/implementation-plan.md:177`) |
| Load field, interests, credentials, countries, funding prefs, CV refs, timezone from a private local profile | **Met** | `private.profile.example.json` (tracked template), `src/infrastructure/local-profile.ts`, `GRADREACH_PROFILE_PATH`, `test/applicant-profile.test.ts` |
| Do not hard-code user profile data into source | **Violated** | `src/infrastructure/gmail-oauth.ts:211` (finding A-01) |
| Search every configured region | **Partial** | Schedule accepts ≤ 45 countries (`automatic-discovery.ts:108`); 42 regions configured; disabled and paused by default |
| Include scholarship-supported and low-tuition routes | **Partial / WIP** | `opportunity-discovery.ts` + `official-opportunity-hosts.ts:12-14` (Erasmus+, DAAD, Microsoft); uncommitted migration and contract tests |
| Never commit CVs, transcripts, tokens, keys, email contents | **Met** | `.gitignore:8-14` plus `next.config.ts:7` `outputFileTracingExcludes` for `private-data/**`; no secret found in tracked files during this audit |
| Treat university/professor pages as untrusted input | **Partial** | Extraction is bounded and quote-based (`research-discovery.ts`, `professor-research-evidence.ts`, 456-line `sanitized-failure.ts`); no explicit prompt-injection detector for fetched page text |
| Deduplicate people/programs | **Met** | Candidate/email dedupe in selection (`outreach-queue.ts:176-195`); URL + person dedupe in enrichment (`confirmed-professor-research-enrichment.ts`, `test:44-48`) |
| Respect provider rate limits and site terms | **Partial** | Search caps and pacing (`minimumRequestIntervalMs`) exist; the observed 15/26 HTTP 422 rate shows provider-side limits are not handled adaptively |
| Send only after the account is explicitly connected and sending enabled | **Met** | `gmail-oauth.ts:282, 286`; `outreach-scheduler.ts:10-13` |
| Never commit a redundant `agent.md`; keep `AGENTS.md` canonical | **Met** | `AGENTS.md` is the only such file in `git ls-files` |

---

## Appendix B · Configuration matrix

| Variable | Required for | Read by | Default / fail mode |
|---|---|---|---|
| `MONGODB_URI` | storage, website, all workers | `src/infrastructure/mongo-storage.ts` | none — connection fails |
| `MONGODB_DATABASE` | optional database override | same | database from the URI |
| `MONGODB_TEST_URI` | `npm run test:mongodb` only | `test/mongo-test-uri.ts` | test skipped; must parse to `gradreach_test` |
| `SEARCH_PROVIDER_API_KEY` | discovery | `brave-search-provider.ts` | discovery action reports unavailable |
| `LLM_PROVIDER_API_KEY` | triage + draft generation | `gemini-draft-provider.ts` | feature unavailable |
| `LLM_PROVIDER_MODEL` | optional model override | same | `gemini-2.5-flash` (`.env.example:9-10`) |
| `EMAIL_PROVIDER_CLIENT_ID` / `EMAIL_PROVIDER_CLIENT_SECRET` | Gmail consent | `gmail-oauth.ts` | connect fails closed |
| `EMAIL_PROVIDER_TOKEN_PATH` | optional token location | same | `private-data/gmail-token.json` |
| `OUTREACH_SENDING_ENABLED` | enables delivery | `outreach-scheduler.ts:10`, `gmail-oauth.ts:282` | any value other than `true` disables sending |
| `GRADREACH_OWNER_EMAIL` | sign-in + ownership checks | `auth.ts`, `owner-access.ts` | every path denied |
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL`, `AUTH_TRUST_HOST` | website sign-in | `auth.ts`, `canStartGoogleSignIn` | sign-in start returns false |
| `GRADREACH_PROFILE_PATH` | alternate private profile | `local-profile.ts` | `private.profile.json` |
| `PORT`, `HOST` | custom server bind | `web-server.ts:13-15` | `3000` / `0.0.0.0`, validated |

Fail-closed default is the strongest part of this design: with no environment at
all, the website denies access, discovery reports unavailable, and the scheduler
exits after printing a disabled notice.

---

## Appendix C · Test inventory (45 files, 289 tests — 288 pass, 1 opt-in skip)

44 files are tracked and `test/search-provider-contract.test.ts` is new in the
working tree (finding A-02).

| Group | Files | Representative size | What it defends |
|---|---|---|---|
| Delivery & queue integrity | `outreach-delivery`, `outreach-queue`, `daily-outreach-planner`, `outreach-review`, `outreach-scheduler`, `outreach-runtime-status` | `outreach-delivery.test.ts` (249) | 5/day cap, draft hash, retry/uncertain semantics, pause |
| Discovery | `research-discovery`, `discovery-runner`, `automatic-discovery`, `discovery-preview`, `discovery-preview-continuation`, `discovery-batch`, `saved-lead-reprocessing`, `saved-preview-diagnostics`, `phase3-pilot-diagnostics`, `read-only-lead-viewer`, `lead-card-view`, `discovery-lead-review`, `country-lead-browser` | `research-discovery.test.ts` (1,367) | identity attribution, exact-host evidence, dedupe, diagnostics |
| Evidence & assessment | `evidence-triage`, `professor-research-evidence`, `confirmed-professors`, `confirmed-professor-research-enrichment`, `program-assessment`, `opportunity-discovery`, `search-provider-contract` | `program-assessment.test.ts` (171) | conservative eligibility, no GPA/currency conversion, no cross-lead attribution, provider response contract |
| Drafting & profile | `outreach-draft`, `candidate-03-draft-preview`, `candidate-review-preview`, `applicant-profile`, `profile-preferences` | `outreach-draft.test.ts` (113) | source citation, private profile parsing |
| Web & access | `owner-access`, `owner-repository-gateway`, `owner-workflows`, `website-navigation-and-data`, `public-welcome-page`, `auth-local-origin`, `dashboard`, `job-progress` | `owner-workflows.test.ts` (226) | owner gating, safe return paths, navigation, Socket.IO auth |
| Platform | `mongo-storage-connection`, `mongo-storage.integration` (skipped), `mongo-test-uri`, `discovery-collection-migration`, `local-env`, `provider-integrations` | `mongo-storage.integration.test.ts` (354) | atomic reservation, migration guard, sanitized failures |

Notable gaps in the map: `app/(owner)/*/page.tsx` rendering is covered only
indirectly through `website-navigation-and-data.test.ts`; there is no DOM/unit
rendering test (no Playwright or Testing Library dependency in
`package.json`), so the UI is verified by typecheck and navigation assertions
only.

---

## Appendix D · Reproducing this audit

```powershell
# from the repository root
git --no-pager log --oneline -5
git status --porcelain
git --no-pager diff --stat

npm run typecheck
npm test

# the opt-in guarantees (needs a disposable MongoDB)
# $env:MONGODB_TEST_URI = 'mongodb://127.0.0.1:27017/gradreach_test'
# npm run test:mongodb
```

Expected results as measured on 2026-11-19:

```
TYPECHECK_EXIT=0
# tests 289
# pass 288
# fail 0
# skipped 1
```

---

## Audit sign-off

- **Release readiness: not ready.** The five-per-day delivery core is genuinely
  safe to enable; the surrounding facts are not. Two High findings are pure
  hygiene (A-01, A-02) and cost about one day to close. The third (A-03) is a
  product decision, not a defect.
- **What is trustworthy today:** access control, draft approval integrity,
  daily-cap enforcement, evidence-source discipline, and the failure-sanitization
  layer. These are better than most production systems at this stage.
- **What must not be claimed yet:** that 200 professors have been researched,
  that replies are tracked, that sending is running, or that any hosting/OAuth
  step has been verified.
- Nothing in this audit was pushed or sent. `AUDIT.md` is the only file this audit
  created; the owner's 18 modified files and 5 untracked paths were left exactly as
  found (finding A-02).
