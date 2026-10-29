# GradReach Agent

Local research and outreach assistance for the 2027 international MSc application cycle. GradReach records source-backed professor/program leads across configured regions, assesses reviewed program facts conservatively, prepares personalized drafts, and plans a maximum of five outreach attempts per local calendar day.

## Current status

The dependency-free core, discovery fixtures, program assessment, source-cited drafts, dashboard, and provider adapters have automated tests. Live Brave search and a generic Gemini smoke request could not be verified because network fetches failed. MongoDB integration was skipped because `MONGODB_TEST_URI` is not configured. Gmail OAuth and sending remain unconnected; sending stays disabled by default, and the app does not contact professors. The scheduled sender, retry/reply/follow-up workflow, and cross-process atomic cap are not complete. See [the phase plan](docs/implementation-plan.md) for exact status.

## Requirements and local checks

- Node.js 22 or newer
- MongoDB for the local dashboard and persistence

```bash
npm install
npm test
npm run typecheck
npm run build
```

Run `npm run test:mongodb` only after setting `MONGODB_TEST_URI` to a disposable test deployment. Each run creates a uniquely named test database and drops only that database. Never point it at personal or production data. `MONGODB_URI` configures the application; `MONGODB_DATABASE` optionally selects its database. `npm run db:indexes` creates indexes in the configured application database and should only be run after checking that target.

## Private profile and environment

Copy `private.profile.example.json` to the ignored `private.profile.json` and enter verified details. Set `GRADREACH_PROFILE_PATH` to use another private profile path. Unknown grades, eligibility, English-test status, funding, and source facts should remain unknown until verified. Program JSON format and source requirements are in [docs/program-record-format.md](docs/program-record-format.md).

Copy `.env.example` to `.env` for local settings. Process environment variables take precedence. Supported variables are:

- `MONGODB_URI`, `MONGODB_DATABASE`, and isolated-test-only `MONGODB_TEST_URI`
- `SEARCH_PROVIDER_API_KEY` for Brave Search
- `LLM_PROVIDER_API_KEY` and optional `LLM_PROVIDER_MODEL` for Gemini draft generation
- `EMAIL_PROVIDER_CLIENT_ID`, `EMAIL_PROVIDER_CLIENT_SECRET`, and optional `EMAIL_PROVIDER_TOKEN_PATH` for Gmail OAuth
- `OUTREACH_SENDING_ENABLED`, an opt-in gate that currently cannot enable delivery because the reviewed daily-cap sender is not implemented; keep it unset or false
- `GRADREACH_PROFILE_PATH` for the private profile location

Never print or commit `.env`, API keys, OAuth client material, access/refresh tokens, private profiles, personal documents, or email contents. These are excluded by `.gitignore`. The default Gmail token file is `private-data/gmail-token.json`, protected with a current-user-only ACL on Windows and owner-only mode on other platforms.

## Research and dashboard

Phase 3 requires a Brave API key and reviewed exact-host allowlists for every configured country. Search results stay unverified until a human reviews official sources. Program assessment never converts GPA scales or assumes funding/affordability. Choose **Generate draft with Gemini** in the dashboard to send the selected candidate name, applicant name and degree, target interest/intake, verified excerpt, and source URL to Gemini; no transcript/CV is sent. Gemini output remains a draft and must pass source/excerpt validation and human approval. The deterministic template option does not call Gemini.

To run the dashboard, set `MONGODB_URI`, create the private profile, run `npm run db:indexes` after verifying the target database, then run:

```bash
npm run app
```

The terminal dashboard reviews evidence and drafts, imports reviewed program JSON, controls pause state, prepares capped queue records, and exports candidates to CSV. It does not send email. The configured target of 200 is displayed but does not yet stop discovery at 200.

## Gmail OAuth setup

Enable Gmail API in Google Cloud, configure an OAuth consent screen, create a Desktop app OAuth client, and add your account as a test user if the app is in testing. Set `EMAIL_PROVIDER_CLIENT_ID` and `EMAIL_PROVIDER_CLIENT_SECRET` locally, then run `npm run gmail:connect` and complete the browser authorization. The application requests only `https://www.googleapis.com/auth/gmail.send` and rejects any expanded scope; it cannot read replies. OAuth uses a loopback callback, state validation, and PKCE. Authorization does not send messages. The sender remains fail-closed even if `OUTREACH_SENDING_ENABLED=true` until an approved, pause-aware, atomic five-per-day delivery workflow exists. The app currently has no scheduled delivery worker, automated retry, reply reader, or follow-up workflow.

## Repository metadata

- Suggested description: `Researches international MSc supervisors and funded or low-tuition programs, verifies official requirements, and manages personalized outreach.`
- Suggested topics: `graduate-admissions`, `study-abroad`, `professor-outreach`, `scholarships`, `research-assistant`, `ai-agent`, `typescript`, `mongodb`, `email-automation`
