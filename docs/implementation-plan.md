# Implementation Plan

## Product target

GradReach is a local research and outreach assistant for 2027 international MSc applications. It targets all countries configured in the private profile, including Canada, Australia, China, Thailand, and Europe (including Portugal and Italy), and supports scholarship and low-tuition routes. Its research target is 200 candidates/programs. It records official-source evidence, keeps unknowns explicit, prepares reviewed drafts, and plans no more than five outreach attempts per calendar day in the configured timezone.

The applicant profile, credentials, grades, English-test status, funding needs, and document references remain configurable private inputs. The repository must not invent those facts or publish them.

## Phases and acceptance

| Phase | Goal and scope | Acceptance / verification | State |
|---|---|---|---|
| 0 | Initialize repository, instructions, metadata, and profile-safe project plan. | Git root and ignore rules are present; no private profile or credential is tracked. | COMPLETE (repository inspection) |
| 1 | Core candidate schema, source evidence fields, duplicate protection, and five-per-day queue rules. | Node tests cover evidence gating, deduplication, local-day accounting, cancellation, and hard cap. | COMPLETE (tests pass) |
| 2 | Private applicant profile and MongoDB persistence for candidates, programs, assessments, scheduler control, and attempts. | Isolated MongoDB CRUD, storage separation, unique indexes, attempt idempotency, and cleanup integration test passes. | IN PROGRESS (MONGODB_TEST_URI absent; live integration not run) |
| 3 | Research discovery across all configured regions using Brave and official university pages. | Deterministic fixture tests pass; limited live Brave request succeeds with configured key. | IN PROGRESS (fixture tests pass; live request failed because network fetch was unavailable) |
| 4 | Conservative program assessment for classification/GPA, English, tuition, funding, intake, and deadlines. | Facts require reviewed dated HTTPS evidence; unsupported or ambiguous claims remain unclear; isolated MongoDB integration passes. | IN PROGRESS (local tests pass; MongoDB integration not run) |
| 5 | Research-fit and personalized draft generation using reviewed evidence and applicant inputs. | Template and Gemini adapters are fixture-tested; draft validation requires exact reviewed excerpt/source and duplicate checks; human approval remains required. | COMPLETE (deterministic and mocked-provider tests pass; live Gemini not checked) |
| 6 | Gmail OAuth/send adapter and safe daily outreach operation. | OAuth state/PKCE, send-only scope, restricted token file, default-disabled sender, daily cap, audit, pause, retry, and reply/follow-up behavior are verified. | IN PROGRESS (OAuth and adapter fixture-tested; no account authorized; no scheduler delivery/retry/reply workflow) |
| 7 | Local dashboard, 200-contact progress, review queue, export, and end-to-end use. | Dashboard supports candidate/program review and capped queue preparation; configured app flow is verified against isolated MongoDB. | IN PROGRESS (dashboard and CSV fixtures pass; MongoDB end-to-end not run) |

## Implemented behavior and boundaries

### Discovery and assessment

Phase 3 searches every configured region, field, and research interest, requires reviewed exact-host HTTPS allowlists, and stores findings as unverified leads with retrieval times and excerpts. Redirects to unapproved hosts are refused. The Brave adapter uses `SEARCH_PROVIDER_API_KEY`. Fixture tests cover query shaping, host validation, redirects, normalization, deduplication, and review gating. A live request was attempted with a generic query; the network fetch failed, so no live-search capability is claimed.

Phase 4 validates reviewed program JSON and keeps unsupported facts unclear. GPA and currency scales are never converted. Affordability is only compared when annual budget and currency are configured. Transcript references can remain in the private profile; transcript parsing is not implemented. Program, assessment, and scheduler repositories/indexes exist, but integration tests are skipped without `MONGODB_TEST_URI`. Do not substitute `MONGODB_URI` unless it is deliberately configured as a disposable test deployment.

### Draft generation

The deterministic draft template and optional `GeminiDraftProvider` use only inputs explicitly supplied by the caller. Choosing the Gemini dashboard option sends the candidate/applicant names, degree, target interest/intake, selected verified excerpt, and source URL to Google's Gemini API; transcript and CV contents are not sent. Gemini output is untrusted and must pass the same source/excerpt and duplicate checks plus human review. `LLM_PROVIDER_API_KEY` and optional `LLM_PROVIDER_MODEL` configure the adapter. No model output approves or sends a message.

### Gmail and outreach

`beginGmailAuthorization` runs a loopback callback with random OAuth state and PKCE. It requests only `https://www.googleapis.com/auth/gmail.send`; it does not request inbox or mailbox access. Tokens go to `EMAIL_PROVIDER_TOKEN_PATH` or the ignored default `private-data/gmail-token.json`; Windows applies a current-user-only file ACL, and other platforms use mode `0600`. The client ID/secret are read from `EMAIL_PROVIDER_CLIENT_ID` and `EMAIL_PROVIDER_CLIENT_SECRET`.

OAuth tokens can be obtained locally, but the Gmail sender is fail-closed even if `OUTREACH_SENDING_ENABLED=true`: it refuses delivery until a reviewed, pause-aware, atomic daily-cap workflow exists. No authorization flow was started, no account was connected, and no email was sent. The terminal app still only prepares queue records; a durable scheduled delivery worker, atomic cross-process day-cap enforcement, retry policy, delivery audit updates, manual reply logging, and follow-up workflow remain incomplete. The send-only scope cannot read replies. The OAuth token exchange rejects a response containing any additional scope.

### Local interface

Phase 7 provides a terminal dashboard, profile/priority changes, queue pause, capped queue-record preparation, reviewed program import, discovery evidence review, draft approval, and formula-safe CSV export. The 200 target is displayed as progress metadata; it does not yet enforce a 200-candidate discovery stopping rule. Running the application end to end requires a private profile and MongoDB configuration.

## Environment variables

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Application MongoDB connection; never point at a personal/production database for tests. |
| `MONGODB_DATABASE` | Optional application database name. |
| `MONGODB_TEST_URI` | Explicit disposable MongoDB deployment for integration tests. Each run uses a unique database and drops only that database. |
| `SEARCH_PROVIDER_API_KEY` | Brave Search API credential. |
| `LLM_PROVIDER_API_KEY` | Gemini API credential. |
| `LLM_PROVIDER_MODEL` | Optional Gemini model override. |
| `EMAIL_PROVIDER_CLIENT_ID` | Google OAuth installed-app client ID. |
| `EMAIL_PROVIDER_CLIENT_SECRET` | Google OAuth installed-app client secret. |
| `EMAIL_PROVIDER_TOKEN_PATH` | Optional local token JSON path; default is ignored `private-data/gmail-token.json`. |
| `OUTREACH_SENDING_ENABLED` | Sending opt-in gate. Leave unset/false; even when true, the current sender remains blocked until the safe delivery workflow is implemented. |
| `GRADREACH_PROFILE_PATH` | Optional private applicant profile JSON path; default is ignored `private.profile.json`. |

The optional `.env` loader does not override variables already present in the process environment. Never print `.env`, OAuth client material, API keys, tokens, or email contents. `.env`, `private-data/`, local profiles, documents, and generated exports are ignored by Git.

## Setup and verification

1. Install Node.js 22+ and run `npm install`.
2. Copy `.env.example` to `.env` and set only the local variables needed for the intended operation. Keep sending disabled.
3. Copy `private.profile.example.json` to the ignored `private.profile.json` and enter only verified profile data.
4. Run `npm test`, `npm run typecheck`, and `npm run build`. Run `npm run test:mongodb` only with an isolated deployment in `MONGODB_TEST_URI`.
5. Run `npm run db:indexes` only after checking that `MONGODB_URI` points to the intended application database.
6. Configure a Google Cloud OAuth consent screen and Desktop app OAuth client, add the account as a test user if the app remains in testing, enable Gmail API, set the two `EMAIL_PROVIDER_*` variables, then run `npm run gmail:connect`. The user must complete the browser consent step locally. This creates tokens but does not send email.

No live Gmail authorization, live send, or production database operation is part of development verification. See [README.md](../README.md) for setup commands and [program-record-format.md](program-record-format.md) for evidence-backed program imports.

## Main data groups

- Applicant profile: academic background, grading scale, goals, research interests, project links, CV/transcript references, English evidence, timezone, and funding constraints.
- Program: institution, course, intake, deadline, tuition, funding route, entry rules, language rules, documents, and official sources.
- Professor: institution, department, official profile, research topics, contact channel, evidence URLs, and last-checked time.
- Outreach: source-backed draft, approval state, scheduled/sent times, provider message ID, response, and follow-up history. Several delivery and reply fields/workflows remain planned, not implemented.

Personal applicant documents and credentials are private local inputs. Do not commit a personal CV or transcript.
