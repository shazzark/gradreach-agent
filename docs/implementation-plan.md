# Implementation Plan

## Product target

GradReach is a local research and outreach assistant for 2027 international MSc applications. It targets the countries configured in the ignored private profile and supports scholarship and low-tuition routes. Its research target is 200 candidates/programs. It records official-source evidence, keeps unknowns explicit, prepares reviewed drafts, and plans no more than five outreach attempts per calendar day in the configured timezone.

The applicant profile, credentials, grades, English-test status, funding needs, and document references remain configurable private inputs. The repository must not invent those facts or publish them.

## Phases and acceptance

| Phase | Goal and scope | Acceptance / verification | State |
|---|---|---|---|
| 0 | Initialize repository, instructions, metadata, and profile-safe project plan. | Git root and ignore rules are present; no private profile or credential is tracked. | COMPLETE (repository inspection) |
| 1 | Core candidate schema, source evidence fields, duplicate protection, and five-per-day queue rules. | Node tests cover evidence gating, deduplication, local-day accounting, cancellation, and hard cap. | COMPLETE (tests pass) |
| 2 | Private applicant profile and MongoDB persistence for profiles, professor candidates, and outreach attempts. | Isolated MongoDB CRUD, private-data separation, unique candidate/attempt indexes, idempotent attempt writes, and cleanup integration test passed in the Phase 2 history. The test was not rerun in this turn because `MONGODB_TEST_URI` is absent. | COMPLETE (previous isolated integration passed; not rerun) |
| 3 | Research discovery across all configured countries using Brave and official university pages. | Deterministic fixture tests pass; exact-host sources are reviewed; limited live queries save unverified leads and official-page evidence. | IN PROGRESS (the pilot is historical and remains unverified/review-gated; six of 45 active countries have exact official hosts documented; no all-country search was run) |
| 4 | Conservative program assessment for classification/GPA, English, tuition, funding, intake, and deadlines. | Facts require reviewed dated HTTPS evidence; unsupported or ambiguous claims remain unclear; isolated MongoDB integration passes. | IN PROGRESS (local tests pass; MongoDB integration not run) |
| 5 | Research-fit and personalized draft generation using reviewed evidence and applicant inputs. | Template and Gemini adapters are fixture-tested; draft validation requires exact reviewed excerpt/source and duplicate checks; human approval remains required. | COMPLETE (deterministic and mocked-provider tests pass; live Gemini smoke request failed at network access) |
| 6 | Gmail OAuth/send adapter and safe daily outreach operation. | OAuth state/PKCE, send-only scope, restricted token file, default-disabled sender, approval-bound delivery, atomic local-day cap, idempotent audit, pause, retry, and manual reply/follow-up behavior are verified. | IN PROGRESS (mocked delivery, cap concurrency, retry, approval, and pause tests pass; live MongoDB and Gmail authorization/send remain unverified) |
| 7 | Local dashboard, 200-contact discovery target, review queue, export, and end-to-end use. | Discovery deduplicates canonical results and stops saving/searching when the configured pool reaches 200; dashboard progress and CSV behavior pass fixtures; configured app flow is verified against isolated MongoDB. | IN PROGRESS (200-target and dashboard fixtures pass; MongoDB end-to-end not run) |

## Implemented behavior and boundaries

### Discovery and assessment

Phase 3 uses reviewed exact-host HTTPS allowlists and refuses redirects or pages outside the listed host. Search queries target faculty, professors, supervisors, labs, and research groups. Brave and official-page failures expose only sanitized categories and safe HTTP status/resource paths; raw errors, response bodies, credentials, and profile-derived search queries are omitted from failure records. Failure categories distinguish timeout, DNS/TLS, HTTP status, rate limit, rejected redirect, disallowed host, invalid content, and other network failures. The bounded historical pilot made one request capped at three results per then-configured region; five searches produced 12 leads. The Thailand retry returned HTTP 422 with the same three-result limit. The initial safe page-fetch workflow added dated, exact-host excerpts for nine leads and copied 42 relevant literal sentence snippets. Of three failed lead pages retried once, both China retries succeeded and the Italy retry returned HTTP 404. The retries added 11 further literal snippets, for 53 total; their source URL, retrieval time, and supporting excerpt are retained. The Italy lead now points to a current official Computer Science and Engineering page; its former failed URL remains in retry history. Captured excerpts did not explicitly support a professor name or email address, so none was extracted. Search and page evidence remains unverified and review-gated. Pilot results are local in ignored `outputs/phase3-search-pilot.json`; active allowlist sources and check dates are in [phase-3-allowlist.md](phase-3-allowlist.md). Each country is eligible for discovery only after its exact official host is documented. Fixture tests cover query shaping, host validation, redirects, normalization, deduplication, failure classification, and review gating. The Brave adapter uses `SEARCH_PROVIDER_API_KEY`.

Phase 4 validates reviewed program JSON and keeps unsupported facts unclear. GPA and currency scales are never converted. Affordability is only compared when annual budget and currency are configured. Transcript references can remain in the private profile; transcript parsing is not implemented. Program, assessment, and scheduler repositories/indexes exist. Their MongoDB integration test is skipped without `MONGODB_TEST_URI`. Do not substitute `MONGODB_URI` unless it is deliberately configured as a disposable test deployment.

### Draft generation

The deterministic draft template and optional `GeminiDraftProvider` use only inputs explicitly supplied by the caller. Choosing the Gemini dashboard option sends the candidate/applicant names, degree, target interest/intake, selected verified excerpt, and source URL to Google's Gemini API; transcript and CV contents are not sent. Gemini output is untrusted and must pass the same source/excerpt and duplicate checks plus human review. `LLM_PROVIDER_API_KEY` and optional `LLM_PROVIDER_MODEL` configure the adapter. No model output approves or sends a message.

### Gmail and outreach

`beginGmailAuthorization` runs a loopback callback with random OAuth state and PKCE. It requests only `https://www.googleapis.com/auth/gmail.send`; it does not request inbox or mailbox access. Tokens go to `EMAIL_PROVIDER_TOKEN_PATH` or the ignored default `private-data/gmail-token.json`; Windows applies a current-user-only file ACL, and other platforms use mode `0600`. The client ID/secret are read from `EMAIL_PROVIDER_CLIENT_ID` and `EMAIL_PROVIDER_CLIENT_SECRET`.

`GmailDeliveryService` remains disabled unless `OUTREACH_SENDING_ENABLED=true`. It delivers only a saved draft whose exact content fingerprint was approved, whose official profile/contact/program evidence remains reviewed, and whose recipient matches the queued address. Mongo claims audit rows atomically, records attempts and provider IDs, reserves the five-message limit atomically per configured local date, blocks while paused, retries only definitive retryable failures (up to three attempts), and marks uncertain outcomes without automatic resend. Queue creation is idempotent by candidate and scheduled instant. The `npm run outreach:scheduler` worker polls once per minute; by default it exits without sending. Keep the account disconnected and the opt-in false during development. No live Gmail authorization or sending was performed. Pause takes effect for future delivery claims; an already in-flight provider request may complete.

The application uses only `https://www.googleapis.com/auth/gmail.send`, so it cannot read replies. The terminal app supports manual reply and follow-up status recording without storing reply contents. Gmail authorization keeps the existing loopback callback, state validation, PKCE, and restricted local token storage; the token exchange rejects any expanded scope. Mock-provider tests do not establish live Gmail or MongoDB behavior.

### Local interface

Phase 7 provides a terminal dashboard, profile/priority changes, queue pause, capped queue-record preparation, reviewed program import, discovery evidence review, draft approval, and formula-safe CSV export. Discovery counts existing unique candidate IDs, excludes canonical source-URL duplicates, and stops immediately after reaching the configured target (capped at 200); the default target is 200. The dashboard shows the resulting progress. Running the application end to end requires a private profile and MongoDB configuration; that live flow remains unverified.

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
| `OUTREACH_SENDING_ENABLED` | Exact string `true` opts the scheduler into delivery; otherwise delivery stays disabled. Leave unset/false except during explicitly approved operation. |
| `GRADREACH_PROFILE_PATH` | Optional private applicant profile JSON path; default is ignored `private.profile.json`. |

The optional `.env` loader does not override variables already present in the process environment. Never print `.env`, OAuth client material, API keys, tokens, or email contents. `.env`, `private-data/`, local profiles, documents, and generated exports are ignored by Git.

## Setup and verification

1. Install Node.js 22+ and run `npm install`.
2. Copy `.env.example` to `.env` and set only the local variables needed for the intended operation. Keep sending disabled.
3. Copy `private.profile.example.json` to the ignored `private.profile.json` and enter only verified profile data.
4. Run `npm test`, `npm run typecheck`, and `npm run build`. Run `npm run test:mongodb` only with an isolated deployment in `MONGODB_TEST_URI`.
5. Run `npm run db:indexes` only after checking that `MONGODB_URI` points to the intended application database.
6. Configure a Google Cloud OAuth consent screen and Desktop app OAuth client, add the account as a test user if the app remains in testing, enable Gmail API, set the two `EMAIL_PROVIDER_*` variables, then run `npm run gmail:connect`. The user must complete the browser consent step locally. This creates tokens but does not send email.
7. The delivery worker is `npm run outreach:scheduler`. It checks the send opt-in on startup, polls every minute, and requires connected Gmail OAuth, MongoDB, an unpaused scheduler, and an explicitly approved draft. Keep the opt-in false during development. Do not use this command to test against real recipients. Set the configured profile timezone to `Africa/Lagos` for the current local-day cap.

No live Gmail authorization, live send, or production database operation is part of development verification. See [README.md](../README.md) for setup commands and [program-record-format.md](program-record-format.md) for evidence-backed program imports.

## Main data groups

- Applicant profile: academic background, grading scale, goals, research interests, project links, CV/transcript references, English evidence, timezone, and funding constraints.
- Program: institution, course, intake, deadline, tuition, funding route, entry rules, language rules, documents, and official sources.
- Professor: institution, department, official profile, research topics, contact channel, evidence URLs, and last-checked time.
- Outreach: source-backed draft, approval state, scheduled/sent times, provider message ID, response, and follow-up history. Several delivery and reply fields/workflows remain planned, not implemented.

Personal applicant documents and credentials are private local inputs. Do not commit a personal CV or transcript.
