import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildDashboardSnapshot, candidatesToCsv } from '../application/dashboard.ts';
import { planDailyOutreach } from '../application/daily-outreach-planner.ts';
import { createGeminiOutreachDraft, createOutreachDraft } from '../application/outreach-draft.ts';
import { approveCandidateForQueue } from '../application/outreach-review.ts';
import { parseApplicantProfile } from '../domain/applicant-profile.ts';
import { markCandidateEvidenceReviewed } from '../application/research-discovery.ts';
import { assessProgram, parseProgramRecord } from '../domain/program-assessment.ts';
import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { loadApplicantProfile } from '../infrastructure/local-profile.ts';

const PROFILE_ID = 'primary';

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function formatReviewQueue(candidates: ProfessorCandidate[]): string {
  const queue = candidates.filter((candidate) => candidate.status === 'needs-evidence' || candidate.status === 'ready-for-review' || Boolean(candidate.personalizedDraft));
  if (queue.length === 0) return 'No candidates need evidence review.';
  return queue.map((candidate) => [
    `${terminalText(candidate.id)} | ${terminalText(candidate.name)} | ${terminalText(candidate.institution)} | ${candidate.status}`,
    ...(candidate.discoveryEvidence ?? []).map((evidence) => `  [${evidence.verification}] ${evidence.kind}: ${terminalText(evidence.sourceUrl)}\n    ${terminalText(evidence.excerpt).slice(0, 240)}`),
    candidate.personalizedDraft ? `  Draft: ${terminalText(candidate.personalizedDraft).slice(0, 500)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

async function run(): Promise<void> {
  const storage = await connectMongoStorage();
  const readline = createInterface({ input: stdin, output: stdout });
  const repositories = storage.repositories;
  const profilePath = process.env.GRADREACH_PROFILE_PATH ?? 'private.profile.json';
  try {
    let profile = await loadApplicantProfile(profilePath);
    await repositories.profiles.save(PROFILE_ID, profile);
    let control = await repositories.schedulerControl.get();
    if (!control) {
      control = { paused: true, timeZone: profile.applicant.target.timezone, dailyLimit: 5 };
      await repositories.schedulerControl.save(control);
    }
    const ask = (prompt: string) => readline.question(prompt);

    for (;;) {
      stdout.write('\nGradReach local dashboard\n1 Dashboard  2 Review evidence  3 Set candidate priority\n4 Edit target profile  5 Pause/resume queue  6 Prepare daily queue\n7 Export candidates CSV  8 Import and assess reviewed program JSON\n9 Review a discovery lead  10 Prepare template draft  11 Approve draft for queue\n12 Generate draft with Gemini  13 Record manual reply/follow-up status  0 Exit\n');
      const choice = (await ask('Choose an option: ')).trim();
      if (choice === '0') break;

      if (choice === '1') {
        const [candidates, programs, attempts] = await Promise.all([repositories.candidates.list(), repositories.programs.list(), repositories.attempts.listAll()]);
        const assessments = (await Promise.all(programs.map((program) => repositories.assessments.latest(program.id)))).filter((item) => item !== undefined);
        const snapshot = buildDashboardSnapshot({ candidates, programs, attempts, assessments, control, now: new Date().toISOString() });
        stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      } else if (choice === '2') {
        stdout.write(`${formatReviewQueue(await repositories.candidates.list())}\n`);
      } else if (choice === '3') {
        const id = (await ask('Candidate ID: ')).trim();
        const candidate = await repositories.candidates.get(id);
        if (!candidate) { stdout.write('Candidate not found.\n'); continue; }
        const priority = Number(await ask('New priority (integer 0-100): '));
        if (!Number.isInteger(priority) || priority < 0 || priority > 100) { stdout.write('Priority must be an integer from 0 to 100.\n'); continue; }
        candidate.priority = priority;
        await repositories.candidates.save(candidate);
        stdout.write('Priority saved.\n');
      } else if (choice === '4') {
        const edit = async (label: string, current: string, list = false): Promise<string> => {
          const answer = await ask(`${label} [${current}]: `);
          return answer.trim() ? (list ? answer.split(',').map((item) => item.trim()).filter(Boolean).join('\u0000') : answer.trim()) : current;
        };
        const countries = await edit('Target countries, comma separated', profile.applicant.target.countries.join(', '), true);
        const fields = await edit('Academic fields, comma separated', profile.applicant.target.fields.join(', '), true);
        const interests = await edit('Research interests, comma separated', profile.applicant.target.researchInterests.join(', '), true);
        const fundingTypes = await edit('Funding preferences, comma separated', profile.applicant.target.fundingTypes.join(', '), true);
        const intake = await edit('Target intake', profile.applicant.target.intake);
        const currentBudget = profile.applicant.target.maxAnnualTuition;
        const budgetInput = (await ask(`Maximum annual tuition budget, or "none" to clear [${currentBudget ?? 'not set'}]: `)).trim();
        const maxAnnualTuition = !budgetInput ? currentBudget : budgetInput.toLowerCase() === 'none' ? null : Number(budgetInput);
        const tuitionCurrency = maxAnnualTuition === null ? '' : await edit('Tuition budget currency (ISO currency code)', profile.applicant.target.tuitionCurrency);
        const timezone = await edit('Timezone', profile.applicant.target.timezone);
        const next = parseApplicantProfile({
          ...profile,
          applicant: { ...profile.applicant, target: {
            ...profile.applicant.target,
            countries: countries.split('\u0000').filter(Boolean), fields: fields.split('\u0000').filter(Boolean),
            researchInterests: interests.split('\u0000').filter(Boolean), fundingTypes: fundingTypes.split('\u0000').filter(Boolean),
            maxAnnualTuition, tuitionCurrency, intake, timezone,
          } },
        });
        await writeFile(resolve(profilePath), `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await repositories.profiles.save(PROFILE_ID, next);
        profile = next;
        control = { ...control, timeZone: timezone };
        await repositories.schedulerControl.save(control);
        stdout.write('Private profile settings saved.\n');
      } else if (choice === '5') {
        control = { ...control, paused: !control.paused };
        await repositories.schedulerControl.save(control);
        stdout.write(`Queue is now ${control.paused ? 'paused' : 'active'}. This does not send email.\n`);
      } else if (choice === '6') {
        const [candidates, attempts] = await Promise.all([repositories.candidates.list(), repositories.attempts.listAll()]);
        const plan = planDailyOutreach({ control, candidates, attempts, now: new Date().toISOString() });
        stdout.write(`${plan.paused ? 'Queue is paused.' : `Proposed ${plan.attemptsToQueue.length} local queue record(s).`}\n`);
        for (const attempt of plan.attemptsToQueue) stdout.write(`  ${attempt.candidateId} -> ${attempt.recipientEmail} at ${attempt.scheduledFor}\n`);
        if (plan.attemptsToQueue.length && (await ask('Save these as queued audit records? Email will not be sent. Type yes to confirm: ')).trim().toLowerCase() === 'yes') {
          for (const attempt of plan.attemptsToQueue) await repositories.attempts.record(attempt);
          stdout.write('Queued audit records saved.\n');
        }
      } else if (choice === '7') {
        const filename = (await ask('CSV path [outputs/candidates.csv]: ')).trim() || 'outputs/candidates.csv';
        const path = resolve(filename);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, candidatesToCsv(await repositories.candidates.list()), 'utf8');
        stdout.write(`Candidate export saved to ${path}\n`);
      } else if (choice === '8') {
        const path = resolve((await ask('Reviewed program JSON path: ')).trim());
        try {
          const program = parseProgramRecord(JSON.parse(await readFile(path, 'utf8')) as unknown);
          const assessment = assessProgram({ program, profile, assessedAt: new Date().toISOString() });
          await repositories.programs.save(program);
          await repositories.assessments.save(assessment);
          stdout.write(`Program saved and assessed: admissions ${assessment.admissions.outcome}, English ${assessment.english.outcome}, tuition ${assessment.tuition.outcome}, funding ${assessment.funding.outcome}, intake ${assessment.intake.outcome}, deadline ${assessment.deadline.outcome}, overall ${assessment.overall}.\n`);
        } catch {
          stdout.write('Program file could not be imported. Confirm its JSON structure and reviewed official evidence fields.\n');
        }
      } else if (choice === '9') {
        const candidate = await repositories.candidates.get((await ask('Candidate ID: ')).trim());
        if (!candidate || candidate.status !== 'needs-evidence' || !candidate.discoveryEvidence?.length) { stdout.write('Select a discovery lead with evidence in needs-evidence status.\n'); continue; }
        stdout.write(`${formatReviewQueue([candidate])}\n`);
        if ((await ask('Have you checked every listed source yourself? Type yes to continue: ')).trim().toLowerCase() !== 'yes') continue;
        const profileSources = candidate.discoveryEvidence.filter((item) => item.kind === 'official-page');
        if (!profileSources.length) { stdout.write('No fetched official page is available to classify as the professor profile.\n'); continue; }
        profileSources.forEach((item, index) => stdout.write(`${index + 1}. ${terminalText(item.sourceUrl)}\n`));
        const profileIndex = Number(await ask('Professor profile source number: ')) - 1;
        const selectedProfile = profileSources[profileIndex];
        if (!selectedProfile) { stdout.write('Invalid source selection.\n'); continue; }
        const professorName = await ask('Professor name exactly as shown on that page: ');
        const institutionName = (await ask('Institution name exactly as shown on the official page: ')).trim();
        if (!institutionName) { stdout.write('Institution name is required; evidence review was not saved.\n'); continue; }
        let reviewed = markCandidateEvidenceReviewed(candidate, candidate.discoveryEvidence.map((item) => item.sourceUrl), selectedProfile.sourceUrl, professorName);
        reviewed.institution = institutionName;
        const contactSources = reviewed.discoveryEvidence?.filter((item) => item.kind === 'contact') ?? [];
        const programSources = reviewed.discoveryEvidence?.filter((item) => item.kind === 'program') ?? [];
        if (contactSources.length) {
          contactSources.forEach((item, index) => stdout.write(`${index + 1}. ${terminalText(item.sourceUrl)}\n`));
          const contactIndex = Number(await ask('Official contact source number (0 to skip): ')) - 1;
          const contact = contactSources[contactIndex];
          if (contact) {
            const email = (await ask('Official email exactly as published on that page: ')).trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { stdout.write('Email format is invalid; profile evidence was not saved.\n'); continue; }
            reviewed.officialEmail = email;
            reviewed.emailSourceUrl = contact.sourceUrl;
            reviewed.officialContactUrl = contact.sourceUrl;
          }
        }
        if (programSources.length) {
          programSources.forEach((item, index) => stdout.write(`${index + 1}. ${terminalText(item.sourceUrl)}\n`));
          const programIndex = Number(await ask('Official program source number (0 to keep existing): ')) - 1;
          const program = programSources[programIndex];
          if (program) reviewed.programUrl = program.sourceUrl;
        }
        reviewed.sourceCheckedAt = new Date().toISOString();
        await repositories.candidates.save(reviewed);
        stdout.write('Evidence review saved. The candidate is ready for human draft review, not approved or sent.\n');
      } else if (choice === '10') {
        const candidate = await repositories.candidates.get((await ask('Candidate ID: ')).trim());
        if (!candidate || candidate.status !== 'ready-for-review' || !candidate.officialProfileUrl) { stdout.write('Candidate must have a reviewed professor profile first.\n'); continue; }
        const evidence = candidate.discoveryEvidence?.find((item) => item.kind === 'professor-profile' && item.verification === 'reviewed');
        if (!evidence) { stdout.write('Reviewed professor-profile evidence is missing.\n'); continue; }
        stdout.write(`${terminalText(evidence.sourceUrl)}\n${terminalText(evidence.excerpt)}\n`);
        const excerpt = await ask('Paste a short exact research passage from the source: ');
        const draft = createOutreachDraft({ candidate, profile, researchSourceUrl: evidence.sourceUrl, researchExcerpt: excerpt });
        candidate.personalizedDraft = JSON.stringify(draft);
        const interest = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields].map((item) => item.trim()).find(Boolean);
        candidate.fitSummary = `Reviewed source excerpt "${draft.personalizationExcerpt}" connects to the configured interest "${interest}". Source: ${draft.personalizationSourceUrl}`;
        await repositories.candidates.save(candidate);
        stdout.write(`Draft prepared for review; it has not been approved or sent.\n${JSON.stringify(draft, null, 2)}\n`);
      } else if (choice === '11') {
        const candidate = await repositories.candidates.get((await ask('Candidate ID: ')).trim());
        if (!candidate?.personalizedDraft) { stdout.write('Candidate has no saved draft.\n'); continue; }
        stdout.write(`${candidate.personalizedDraft}\n`);
        if ((await ask('Approve this reviewed candidate for the capped local queue? Email will not be sent. Type yes: ')).trim().toLowerCase() !== 'yes') continue;
        const approved = approveCandidateForQueue(candidate, await repositories.attempts.listAll());
        await repositories.candidates.save(approved);
        stdout.write('Candidate approved for queue planning. No email was sent.\n');
      } else if (choice === '12') {
        const candidate = await repositories.candidates.get((await ask('Candidate ID: ')).trim());
        if (!candidate || candidate.status !== 'ready-for-review' || !candidate.officialProfileUrl) { stdout.write('Candidate must have a reviewed professor profile first.\n'); continue; }
        const evidence = candidate.discoveryEvidence?.find((item) => item.kind === 'professor-profile' && item.verification === 'reviewed');
        if (!evidence) { stdout.write('Reviewed professor-profile evidence is missing.\n'); continue; }
        stdout.write(`${terminalText(evidence.sourceUrl)}\n${terminalText(evidence.excerpt)}\n`);
        const excerpt = await ask('Paste a short exact research passage from the source: ');
        const draft = await createGeminiOutreachDraft({
          candidate, profile, researchSourceUrl: evidence.sourceUrl, researchExcerpt: excerpt,
          attempts: await repositories.attempts.listAll(),
        });
        candidate.personalizedDraft = JSON.stringify(draft);
        const interest = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields].map((item) => item.trim()).find(Boolean);
        candidate.fitSummary = `Gemini wording uses reviewed excerpt "${draft.personalizationExcerpt}" for configured interest "${interest}". Source: ${draft.personalizationSourceUrl}`;
        await repositories.candidates.save(candidate);
        stdout.write(`Gemini draft saved for human review; it has not been approved or sent.\n${JSON.stringify(draft, null, 2)}\n`);
      } else if (choice === '13') {
        const candidateId = (await ask('Candidate ID with a sent message: ')).trim();
        const replyChoice = (await ask('Reply status: 1 replied, 2 no response, 3 declined: ')).trim();
        const replyStatus = replyChoice === '1' ? 'replied' : replyChoice === '2' ? 'no-response' : replyChoice === '3' ? 'declined' : undefined;
        if (!replyStatus) { stdout.write('Unknown reply status.\n'); continue; }
        const followChoice = (await ask('Follow-up: 1 not planned, 2 due, 3 scheduled, 4 closed: ')).trim();
        const followUpStatus = followChoice === '1' ? 'not-planned' : followChoice === '2' ? 'due' : followChoice === '3' ? 'scheduled' : followChoice === '4' ? 'closed' : undefined;
        if (!followUpStatus) { stdout.write('Unknown follow-up status.\n'); continue; }
        const followUpScheduledFor = followUpStatus === 'scheduled' ? (await ask('Follow-up time (ISO date/time): ')).trim() : undefined;
        const recorded = await repositories.attempts.recordManualOutcome({
          candidateId, replyStatus, followUpStatus, recordedAt: new Date().toISOString(),
          ...(followUpScheduledFor ? { followUpScheduledFor } : {}),
        });
        stdout.write(recorded ? 'Manual response/follow-up status saved. Message contents were not stored.\n' : 'No sent outreach was found for that candidate.\n');
      } else {
        stdout.write('Unknown option.\n');
      }
    }
  } finally {
    readline.close();
    await storage.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run().catch(() => {
    process.stderr.write('GradReach could not start; check local configuration and MongoDB access.\n');
    process.exitCode = 1;
  });
}
