# GradReach Agent

[![CI](https://github.com/shazzark/gradreach-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/shazzark/gradreach-agent/actions/workflows/ci.yml)

Local research and outreach assistance for the 2027 international MSc application cycle. GradReach records source-backed professor/program leads across configured regions, assesses reviewed program facts conservatively, prepares personalized drafts, and plans a maximum of five outreach attempts per local calendar day.

## Current status

Core discovery, program assessment, source-cited drafts, the private website, scheduling safeguards, and Socket.IO progress have automated tests, and `npm run typecheck` and `npm test` pass locally. The most recent authorized bounded search continuation made 26 requests; 15 returned HTTP 422, and no lead passed all save checks. Gemini was not called, and scheduled discovery and sending remain disabled. On 2026-11-11 one Gmail self-test message was delivered to the owner's own address; no professor outreach has been sent and Gmail authorization is connected only for that owner account. Reply status can be recorded manually, and the read-only `npm run ops:sync-replies` pass exists but has not yet been run against the live mailbox. See [the phase plan](docs/implementation-plan.md) for current status and owner actions.

## Requirements and local checks

- Node.js 22 or newer
- MongoDB for the private website and persistence

```bash
npm install
npm test
npm run typecheck
npm run build
```

Two runtimes exist. `start` and every `ops:*` script first run `npm run build:server`, which compiles the server entry points with `tsc` into the ignored `dist/` directory, and then run the compiled JavaScript on plain Node.js. `dev`, `web`, `debug:*`, and the test scripts run TypeScript sources directly and therefore pass `--experimental-strip-types`; they are development tools. `npm run build` is the website build (`next build`) and `npm run build:server` is the server compile. The script taxonomy and the production-start decision are recorded in [docs/phase-8-production-readiness.md](docs/phase-8-production-readiness.md).

`npm run test:mongodb` requires `MONGODB_TEST_URI` to parse to exactly `gradreach_test` on a disposable test deployment. It migrates legacy discovery collection names if present, writes synthetic fixtures, and drops only its nine named collections in that database. It does not create a unique database or drop the database itself. Never point it at personal or production data. `MONGODB_URI` configures the application; `MONGODB_DATABASE` optionally selects its database. `npm run ops:db-indexes` creates indexes in the configured application database and should only be run after checking that target.

## Discovery collection rename

Discovery leads are stored in `discovery_leads`; their saved triage recommendations are stored in `lead_triage_recommendations`. After MongoDB connectivity is available, before using a database that still has `professor_candidates` or `candidate_evidence_triage`, take a verified backup, stop every GradReach app and scheduler instance, and confirm the effective database (`MONGODB_DATABASE` when set, otherwise the database in the URI). Then run `npm run ops:db-migrate-discovery` using an account permitted to rename collections. The command renames collections in place with `dropTarget: false`, preserving documents, IDs, and indexes. It is safe to rerun after a partial migration. If both an old and replacement name already exist, it stops without overwriting or merging either collection. Afterward, verify the new collection counts and index names and confirm the old names are gone before restarting GradReach. Application storage and index creation refuse to proceed while legacy collection names remain; the application role must be able to list collection names for this startup guard.

## Private profile and environment

Copy `private.profile.example.json` to the ignored `private.profile.json` and enter verified details. Set `GRADREACH_PROFILE_PATH` to use another private profile path. Unknown grades, eligibility, English-test status, funding, and source facts should remain unknown until verified. Program JSON format and source requirements are in [docs/program-record-format.md](docs/program-record-format.md).

Copy `.env.example` to `.env` for local settings. Process environment variables take precedence. Supported variables are:

- `MONGODB_URI`, `MONGODB_DATABASE`, and isolated-test-only `MONGODB_TEST_URI`
- `SEARCH_PROVIDER_API_KEY` for Brave Search
- `LLM_PROVIDER_API_KEY` and optional `LLM_PROVIDER_MODEL` for Gemini draft generation
- `EMAIL_PROVIDER_CLIENT_ID`, `EMAIL_PROVIDER_CLIENT_SECRET`, and optional `EMAIL_PROVIDER_TOKEN_PATH` for Gmail OAuth
- `OUTREACH_SENDING_ENABLED`, which must be exactly `true` to opt the scheduler into sending; keep it unset or false during development
- `GRADREACH_PROFILE_PATH` for the private profile location
- `GRADREACH_REVIEW_REGION` for the official-host allowlist used by `debug:leads-review-preview` when `--region` is not passed; unset means `Canada` with a stderr warning
- `GRADREACH_OWNER_EMAIL` exact owner Google account email for the private website; required and fail-closed
- `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `AUTH_SECRET` for website identity and signed sessions
- `AUTH_TRUST_HOST=true` when running behind the configured trusted hosting proxy; sign-in stays unavailable without it
- `AUTH_URL` for the exact deployed HTTPS origin (see [private deployment setup](docs/private-website-deployment.md))

Never print or commit `.env`, API keys, OAuth client material, access/refresh tokens, private profiles, personal documents, or email contents. These are excluded by `.gitignore`. The default Gmail token file is `private-data/gmail-token.json`, protected with a current-user-only ACL on Windows and owner-only mode on other platforms.

## Research and private website

Phase 3 requires a Brave API key and reviewed exact-host allowlists for every configured country. Search results stay unverified until a human reviews official sources. Program assessment never converts GPA scales or assumes funding/affordability. The website can optionally send selected bounded official excerpts and configured research interests to Gemini for evidence triage when the owner explicitly submits that action. Recommendations remain advisory. Drafts use the deterministic source-cited template and must pass evidence checks and explicit human approval.

For local development, configure the server-side website settings and `MONGODB_URI`, ensure the `primary` applicant profile exists in `gradreach`, then run:

```bash
npm run dev
```

Phase 7 is a private Next.js App Router website styled with Tailwind CSS. The public welcome page at `/` contains no private data; `/workspace` and all feature pages require owner authentication. Google OIDC accepts only the verified account whose email matches `GRADREACH_OWNER_EMAIL`; there is no signup or invitation path. Unauthenticated workspace links return to their requested local path after sign-in. Proxy checks are backed by page-layout, server-action, and database-repository authorization checks. The website reuses existing MongoDB repositories and application services for country-grouped discovery, evidence review and optional AI recommendations, program assessment, profile settings, source-cited drafts, explicit draft approval, queue planning, pause controls, and status tracking. Search and Gemini calls require an explicit owner action; neither runs on page load. Website sign-in does not authorize Gmail. No website action directly sends email.

Build and run the production server with `npm run build` (the website build) and `npm start`. `npm start` compiles the server entry points with `npm run build:server` and then launches the compiled `dist/interfaces/web-server.js` on plain Node.js, so no experimental flag is involved; the process requires development dependencies because the compile runs at start-up. The owner-only hosting, Google OAuth, private environment variables, Atlas egress, and deployment steps are documented in [docs/private-website-deployment.md](docs/private-website-deployment.md). The app is prepared for deployment but has not been published. The older `npm run ops:terminal-app` terminal utility remains available for local operations and profile initialization.

To view undecided professor leads without starting the website, run `npm run debug:leads-view`. This standalone command reads candidate and saved triage records only; it does not load or save the private profile, update scheduler state, or call a search, AI, or email provider. Discovery stops adding candidates at its configurable target (default 200, maximum 200).

## Gmail OAuth setup

Enable Gmail API in Google Cloud, configure an OAuth consent screen, create a Desktop app OAuth client, and add your account as a test user if the app is in testing. Set `EMAIL_PROVIDER_CLIENT_ID` and `EMAIL_PROVIDER_CLIENT_SECRET` locally, then run `npm run ops:gmail-connect` and complete the browser authorization. The application requests `https://www.googleapis.com/auth/gmail.send` plus `https://www.googleapis.com/auth/gmail.readonly`; sending is the only write it can perform. OAuth uses a loopback callback, state validation, and PKCE. Authorization does not send messages, and an existing send-only token must be re-authorized once to gain reply detection. See [docs/phase-7-gmail-reply-sync.md](docs/phase-7-gmail-reply-sync.md) for the read-only design and its limits.

The worker command is `npm run ops:outreach-scheduler`; it polls every minute and stays disabled unless `OUTREACH_SENDING_ENABLED=true`. It writes a heartbeat to the `scheduler_heartbeat` collection on every poll, and `/outreach` shows a red banner when that heartbeat is more than two minutes old, so a crashed or closed worker is visible without reading a terminal; see [docs/phase-5-worker-supervision.md](docs/phase-5-worker-supervision.md) for persistent-run recipes. It requires an unpaused scheduler and a draft explicitly approved for its exact saved content. Mongo stores idempotent delivery audit rows and atomically reserves at most five send attempts per configured local calendar day. Only definitive retryable failures are retried, up to three attempts; an uncertain provider outcome is never automatically resent. A pause blocks future claims, while an already in-flight request may finish. Reply and follow-up status can still be recorded manually in the website or terminal app, and `npm run ops:sync-replies` adds a read-only pass that marks an attempt `replied` when a newer message from another sender exists in that send's Gmail thread; it reads only the `From` header and message ids, never a subject or body. Do not enable sending to test the integration; automated delivery tests use a mock provider and do not prove live Gmail or MongoDB behavior.

## Repository metadata

- Suggested description: `Researches international MSc supervisors and funded or low-tuition programs, verifies official requirements, and manages personalized outreach.`
- Suggested topics: `graduate-admissions`, `study-abroad`, `professor-outreach`, `scholarships`, `research-assistant`, `ai-agent`, `typescript`, `mongodb`, `email-automation`
