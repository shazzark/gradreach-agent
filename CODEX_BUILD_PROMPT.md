# Codex Build Prompt

You are continuing the GradReach Agent repository. Read `AGENTS.md`, `README.md`, and `docs/implementation-plan.md` first. Inspect the current working tree and tests before changing files.

## Owner's requested outcome

Build the full personal outreach agent, not a reduced demo. The agent must research a pool of 200 relevant professors and MSc programs for the configured intake and global scope, include both scholarship-supported and low-tuition routes, check each program against the applicant's actual degree classification and grading-scale details, and prepare and send five individually researched emails per day. Track professor replies, follow-ups, and application routes. A transcript may be added later and must be attachable without rebuilding the profile.

Read the applicant's academic direction, countries, credentials, CV and portfolio/project links from ignored local private-profile files. Never put real applicant data or personal documents into fixtures, source code, or this public prompt.

## Required workflow

1. Continue from the current phase state; do not restart or broaden the product.
2. Keep official source URLs, retrieval dates, and evidence summaries for professor research, program fit, 2:2/GPA requirements, scholarships, tuition, English-test rules, deadlines, and contact details.
3. Treat missing or ambiguous evidence as unknown and queue it for human review. Do not guess eligibility, funding, or email addresses.
4. Use the configured timezone (initially Africa/Lagos) for a strict maximum of five sends per calendar day. Prevent duplicate recipients and idempotently record provider message IDs.
5. Implement real scheduled email sending, with an authenticated email provider, an explicit enable/pause switch, a send log, retry protection, and user-visible review controls. Do not send to real recipients until the owner connects an account and enables the sending workflow.
6. Keep the stack TypeScript, Node.js, MongoDB, strict types, native ES modules, and Windows-first. Add integrations only when needed for an accepted phase.
7. Use relevant installed skills and Codex subagents for substantial independent phases where available and permitted. The primary agent owns integration and verification.
8. Before each phase, state the goal, scope, dependencies, acceptance conditions, and verification. Implement one phase at a time, run its checks, inspect the diff, and update the plan truthfully. Stop phase advancement on a failed required check.

## Current code

Phase 0 is complete. Phase 1 is in progress. `src/domain/outreach-queue.ts` selects only approved candidates with evidence fields, deduplicates recipients, uses the configured timezone for date accounting, and caps a batch at five. Its tests use Node's built-in test runner. Preserve these contracts and add meaningful tests for any new behavior.

## Immediate next task

Complete Phase 1 with a review of the queue code and tests, then implement Phase 2: validate a private applicant profile schema and MongoDB persistence for candidates and outreach attempts. Design the profile import so the current academic/job CV can be loaded privately now and the transcript added later. Do not invent or bundle personal file data into fixtures. If MongoDB credentials are absent, implement repository interfaces and unit tests, clearly report database integration as blocked, and continue only with in-scope work that does not depend on the service.

## Verification and reporting

Run `npm test`, `npm run typecheck`, and `npm run build` when dependencies are installed; otherwise report exactly which commands are blocked and why. Test MongoDB behavior against a disposable local test database where available. Never claim real web search, scholarship verification, or email delivery until end-to-end tested with configured services. Report the exact phase state, changed paths, checks run, limitations, and next authorized phase. Do not ask whether to continue through already authorized phases.
