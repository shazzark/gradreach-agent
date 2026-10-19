# GradReach Agent

AI-assisted research and outreach for the 2027 international MSc application cycle. GradReach finds potential supervisors and programs, records evidence from official sources, checks funding and entry requirements against an applicant profile, prepares personalized professor emails, and manages a five-contact-per-day outreach schedule.

## Project status

The core contact and daily-queue rules are verified. Phase 2 profile validation and MongoDB repositories for the private profile, candidates, and outreach attempts passed integration tests against a local MongoDB test database. Phase 3 now has an opt-in Brave Search adapter and a discovery pipeline that searches each configured region against explicitly reviewed official institution hosts, saves retrieval timestamps and unverified excerpts, and keeps candidates blocked for review. Live search is not configured or verified, and official program and contact evidence capture remains incomplete. No remote or production database is configured. Program eligibility analysis, email-provider integration, and the user interface remain unimplemented. No email is sent by this phase.

## Requirements

- Node.js 22 or newer

## Run the core tests

```bash
npm test
```

Set `MONGODB_TEST_URI` to an isolated MongoDB test deployment and run `npm run test:mongodb` to verify profile, candidate, and attempt CRUD and index behavior against MongoDB. The integration test creates and drops a uniquely named test database. Set `MONGODB_URI` (and optionally `MONGODB_DATABASE`) and run `npm run db:indexes` to create the Phase 2 indexes as an explicit setup step.

Phase 3 discovery requires a `SEARCH_PROVIDER_API_KEY` in the process environment and an explicit reviewed exact-host allowlist for every country in the private applicant profile. Each hostname is matched exactly; list any required subdomains separately. Search results are stored as unverified leads and are not approved for outreach. Do not put applicant profile details in search queries beyond the configured academic fields and research interests.

MongoDB and profile settings are read from the process environment; this project does not load `.env` automatically.

Set `GRADREACH_PROFILE_PATH` to a private local JSON profile when loading applicant details. The default is the ignored `private.profile.json`; `private.profile.example.json` contains only blank example values.

## Repository metadata

- Suggested GitHub description: `Researches international MSc supervisors and funded or low-tuition programs, verifies official requirements, and manages personalized outreach.`
- Suggested topics: `graduate-admissions`, `study-abroad`, `professor-outreach`, `scholarships`, `research-assistant`, `ai-agent`, `typescript`, `mongodb`, `email-automation`

Personal applicant data, transcripts, CVs, OAuth credentials, and API keys must stay outside this repository.
