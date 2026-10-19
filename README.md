# GradReach Agent

AI-assisted research and outreach for the 2027 international MSc application cycle. GradReach finds potential supervisors and programs, records evidence from official sources, checks funding and entry requirements against an applicant profile, prepares personalized professor emails, and manages a five-contact-per-day outreach schedule.

## Project status

The core contact and daily-queue rules are verified. Phase 2 adds local applicant-profile validation and MongoDB repositories for the private profile, candidates, and outreach attempts; the MongoDB service is not configured here, so live persistence and index behavior have not been verified. Web research, program eligibility analysis, email-provider integration, and the user interface remain unimplemented. No email is sent by this phase.

## Requirements

- Node.js 22 or newer

## Run the core tests

```bash
npm test
```

Set `MONGODB_TEST_URI` to an isolated MongoDB test deployment and run `npm run test:mongodb` to verify profile, candidate, and attempt CRUD and index behavior against MongoDB. The integration test creates and drops a uniquely named test database. Set `MONGODB_URI` (and optionally `MONGODB_DATABASE`) and run `npm run db:indexes` to create the Phase 2 indexes as an explicit setup step.

MongoDB and profile settings are read from the process environment; this project does not load `.env` automatically.

Set `GRADREACH_PROFILE_PATH` to a private local JSON profile when loading applicant details. The default is the ignored `private.profile.json`; `private.profile.example.json` contains only blank example values.

## Repository metadata

- Suggested GitHub description: `Researches international MSc supervisors and funded or low-tuition programs, verifies official requirements, and manages personalized outreach.`
- Suggested topics: `graduate-admissions`, `study-abroad`, `professor-outreach`, `scholarships`, `research-assistant`, `ai-agent`, `typescript`, `mongodb`, `email-automation`

Personal applicant data, transcripts, CVs, OAuth credentials, and API keys must stay outside this repository.
