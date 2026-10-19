# Implementation Plan

## Product target

GradReach is a configurable research and outreach agent for the 2027 international MSc application cycle. It should build and maintain a verified pool of 200 professors/programs across the configured countries and regions, covering scholarships and low-tuition programs, then prepare and send up to five tailored professor emails per day. Applicant credentials and document references load from a private profile. A transcript can be added later without rebuilding the profile.

The academic interests and country list are editable configuration. Search and program verification must not silently narrow this scope.

## Phases and acceptance

| Phase | Goal and scope | Acceptance / verification | State |
|---|---|---|---|
| 0 | Initialize repository, instructions, metadata, and profile-safe project plan. | Dedicated Git root; secrets and applicant files ignored; project goal and full scope recorded. | COMPLETE |
| 1 | Core candidate schema, source evidence fields, duplicate protection, and five-per-day queue rules. | Tests prove evidence gating, deduplication, local-day accounting, cancellation handling, and hard cap of five. | COMPLETE |
| 2 | Applicant profile plus MongoDB persistence for the private profile, professor candidates, and outreach attempts, including CV/portfolio references and later transcript import. | CRUD persists the profile/candidates/attempts; private profile data stays in its own collection; candidate and attempt indexes and retry-safe attempt writes pass integration tests against an isolated MongoDB database. | COMPLETE |
| 3 | Research discovery across all configured regions using a search provider and official university pages. | Candidate records contain official profile/program/contact URLs, retrieval time, and source excerpts; no unsupported fields are treated as facts. | NOT STARTED |
| 4 | Program eligibility and finance assessment: 2:2/GPA, transcript documents, English evidence, tuition, scholarship and deadlines. | Every assessment has official evidence, uncertainty, source date, and a clear eligible/unclear/ineligible outcome. | NOT STARTED |
| 5 | Research-fit analysis and personalized email generation based on the applicant profile, verified professor research, and project evidence. | Drafts cite the research fact they refer to; unsupported claims are rejected; duplicate and template-only emails fail review. | NOT STARTED |
| 6 | Daily scheduler and email provider integration with a five-per-day cap in Africa/Lagos time, audit records, pause/resume, retries, and replies/follow-ups. | Integration tests and a test account prove no sixth send, no duplicate send, no retry duplication, and a working pause. | NOT STARTED |
| 7 | User interface, 200-contact progress view, review queue, CSV/XLSX export, and complete end-to-end verification. | User can inspect sources/drafts, edit profile and priorities, operate daily queue, and review outcome metrics. | NOT STARTED |

## Current phase boundaries

Phase 1 implements pure queue-selection rules. Phase 2 validates the private local profile at runtime and provides separate MongoDB repositories for profiles, professor candidates, and outreach attempts, plus the explicit `npm run db:indexes` setup command. Attempt writes are idempotent by candidate and scheduled instant. CRUD, private-data separation, uniqueness, attempt idempotency, and indexes passed integration tests against a uniquely named local MongoDB test database. No remote or production database is configured. This phase does not search the web, connect to an email account, create a CV, or send messages. The long-term authorized workflow is five real emails per day, not merely five drafts.

## Main data groups

- Applicant profile: academic background, grading scale, goals, research interests, project links, CV reference, transcript reference, English evidence, timezone, and funding constraints.
- Program: institution, course, intake, deadline, tuition, funding route, entry rules, language rules, documents, and official sources.
- Professor: institution, department, official profile, research topics, contact channel, evidence URLs, and last-checked time.
- Outreach: tailored subject/body, source-backed personalization note, approval state, scheduled/sent times, provider message ID, response, and follow-up history.

Personal documents and credentials are local/private inputs. The public source repository contains no personal CV or transcript.
