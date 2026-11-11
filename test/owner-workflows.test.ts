import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { OutreachAttempt, ProfessorCandidate, SchedulerControl } from '../src/domain/outreach-queue.ts';
import type { ProgramRecord } from '../src/domain/program-assessment.ts';
import type { GradReachRepositories } from '../src/infrastructure/mongo-storage.ts';
import { addPlannedAttempts, approveReviewedDraft, assessSavedProgram, importAndAssessProgram, recordOutreachOutcome, reviewProfessorEvidence, reviewProgramOpportunity, saveApplicantProfile, saveProfileSettings, saveReviewedDraft, toggleOutreachPause } from '../src/web/owner-workflows.ts';

const profile = parseApplicantProfile(JSON.parse(await readFile(new URL('../private.profile.example.json', import.meta.url), 'utf8')));
profile.applicant.fullName = 'Synthetic Applicant';
profile.applicant.target.fields = ['computer science'];
profile.applicant.target.researchInterests = ['distributed systems'];
const page = 'https://university.example.edu/people/professor';
const contact = 'https://university.example.edu/people/contact';
const research = 'Professor Example researches resilient distributed systems for public infrastructure.';

function candidate(overrides: Partial<ProfessorCandidate> = {}): ProfessorCandidate {
  return {
    id: 'candidate-1', name: 'Professor Example | Systems Lab', professorName: 'Professor Example',
    institution: 'Example University', country: 'Exampleland', leadType: 'professor_profile',
    officialProfileUrl: page, officialContactUrl: contact, officialEmail: 'professor@example.edu', emailSourceUrl: contact,
    programUrl: 'https://university.example.edu/masters', sourceCheckedAt: '2026-10-31T00:00:00Z',
    status: 'ready-for-review', approvedForSending: false, priority: 1,
    discoveryEvidence: [
      { kind: 'professor-profile', sourceUrl: page, excerpt: research, quote: research, retrievedAt: '2026-10-31T00:00:00Z', verification: 'reviewed', region: 'Exampleland', query: 'private query' },
      { kind: 'contact', sourceUrl: contact, excerpt: 'Official contact for Professor Example.', retrievedAt: '2026-10-31T00:00:00Z', verification: 'reviewed', region: 'Exampleland', query: 'private query' },
      { kind: 'program', sourceUrl: 'https://university.example.edu/masters', excerpt: 'Official masters program.', retrievedAt: '2026-10-31T00:00:00Z', verification: 'reviewed', region: 'Exampleland', query: 'private query' },
    ],
    ...overrides,
  };
}

function repositories(input: {
  candidate?: ProfessorCandidate; savedCandidate?: ProfessorCandidate; savedProfile?: unknown; savedControl?: SchedulerControl;
  program?: ProgramRecord; savedProgram?: ProgramRecord; savedAssessment?: unknown; savedAttempts?: OutreachAttempt[]; savedOutcome?: unknown;
} = {}): GradReachRepositories {
  let stored = input.candidate ?? candidate();
  const attempts = { async listAll() { return []; } };
  return {
    profiles: { async get() { return profile; }, async save(_id: string, value: typeof profile) { input.savedProfile = value; } } as never,
    candidates: { async get(id: string) { return stored.id === id ? structuredClone(stored) : undefined; }, async save(value: ProfessorCandidate) { stored = structuredClone(value); input.savedCandidate = structuredClone(value); }, async list() { return [stored]; } } as never,
    schedulerControl: { async get() { return input.savedControl; }, async save(value: SchedulerControl) { input.savedControl = value; } } as never,
    attempts: {
      async listAll() { return input.savedAttempts ?? []; },
      async record(value: OutreachAttempt) { input.savedAttempts = [...(input.savedAttempts ?? []), value]; },
      async recordManualOutcome(value: unknown) { input.savedOutcome = value; return true; },
    } as never,
    programs: {
      async get(id: string) { return input.program?.id === id ? input.program : undefined; },
      async save(value: ProgramRecord) { input.savedProgram = value; return { id: value.id, duplicate: false }; },
      async list() { return input.program ? [input.program] : []; },
    } as never,
    assessments: { async save(value: unknown) { input.savedAssessment = value; } } as never,
    evidenceTriage: { async get() { return undefined; }, async list() { return []; }, async save() {} } as never,
  } as unknown as GradReachRepositories;
}

test('website review workflow calls the existing source-evidence verifier and saves the reviewed profile', async () => {
  const initial = candidate({ status: 'needs-evidence', discoveryEvidence: [
    { kind: 'official-page', sourceUrl: page, excerpt: research, quote: research, retrievedAt: '2026-10-31T00:00:00Z', verification: 'unverified', region: 'Exampleland', query: 'private query' },
  ] });
  const repoState: { candidate: ProfessorCandidate; savedCandidate?: ProfessorCandidate } = { candidate: initial };
  const repos = repositories(repoState);
  await reviewProfessorEvidence({ repositories: repos, candidateId: initial.id, reviewedSourceUrls: [page], profileUrl: page, professorName: 'Professor Example' });
  const saved = (repos.candidates as unknown as { get(id: string): Promise<ProfessorCandidate | undefined> });
  const reviewed = await saved.get(initial.id);
  assert.equal(reviewed?.professorName, 'Professor Example');
  assert.equal(reviewed?.discoveryEvidence?.[0]?.verification, 'reviewed');
  assert.equal(reviewed?.status, 'ready-for-review');
  assert.equal(reviewed?.approvedForSending, false);
  assert.equal(repoState.savedCandidate?.approvedForSending, false);
});

test('profile settings preserve private identity and degree fields while persisting the existing profile shape', async () => {
  const state: { savedProfile?: unknown; savedControl?: SchedulerControl } = {};
  const repos = repositories(state);
  const next = await saveProfileSettings({ repositories: repos, current: profile, settings: { countries: ['Canada'], researchInterests: ['privacy'], timezone: 'UTC' } });
  assert.deepEqual(next.applicant.target.countries, ['Canada']);
  assert.deepEqual(next.applicant.target.researchInterests, ['privacy']);
  assert.equal(next.applicant.fullName, 'Synthetic Applicant');
  assert.equal(state.savedProfile, next);
  assert.equal(state.savedControl?.timeZone, 'UTC');
  assert.equal(state.savedControl?.paused, true);
});

test('saving complete research-interest entries preserves commas and every other profile field', async () => {
  const current = structuredClone(profile);
  current.applicant.target.researchInterests = ['Cybersecurity', 'privacy', 'and network security'];
  const before = structuredClone(current);
  const interests = [
    'Cybersecurity, privacy, and network security', 'AI and machine learning',
    'Software engineering, cloud, and distributed systems',
    'Robotics and autonomous systems, including intelligent robotics and robot perception',
    'Database systems and data-intensive applications',
    'Mobile computing and human-computer interaction, including accessibility',
  ];
  const state: { savedProfile?: unknown; savedControl?: SchedulerControl } = {};
  const repos = repositories(state);
  const saved = await saveProfileSettings({ repositories: repos, current, settings: { researchInterests: interests } });
  assert.deepEqual(saved.applicant.target.researchInterests, interests);
  assert.deepEqual(saved.applicant, { ...before.applicant, target: { ...before.applicant.target, researchInterests: interests } });
  assert.deepEqual((state.savedProfile as typeof profile).applicant.target.researchInterests, interests);
});

test('full profile setup saves only primary and persists the owner-edited country list', async () => {
  const current = structuredClone(profile);
  current.applicant.target.countries = ['Country A', 'Country B'];
  const edited = structuredClone(current);
  edited.applicant.target.countries = ['Japan', 'Holy See'];
  edited.applicant.target.researchInterests = ['privacy-preserving machine learning', 'reliable distributed systems'];
  edited.applicant.email = '';
  edited.applicant.phone = '';
  edited.applicant.degree.gpaScale = null;
  edited.applicant.englishEvidence = { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' };
  edited.applicant.documents = { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] };
  const state: { savedProfile?: unknown; savedControl?: SchedulerControl } = {
    savedControl: { paused: true, timeZone: 'UTC', dailyLimit: 4 },
  };
  const repos = repositories(state);
  await saveApplicantProfile({ repositories: repos, edited });
  const saved = state.savedProfile as typeof profile;
  assert.deepEqual(saved.applicant.target.countries, ['Japan', 'Holy See']);
  assert.deepEqual(saved.applicant.target.researchInterests, ['privacy-preserving machine learning', 'reliable distributed systems']);
  assert.equal(saved.applicant.email, '');
  assert.equal(saved.applicant.phone, '');
  assert.equal(saved.applicant.degree.gpaScale, null);
  assert.equal(saved.applicant.documents.transcriptPath, '');
  assert.equal(state.savedControl?.timeZone, 'UTC');
  assert.equal(state.savedControl?.dailyLimit, 4);
});

test('website draft workflow uses the source-cited draft service and cannot approve while saving', async () => {
  const repoState: { savedCandidate?: ProfessorCandidate } = {};
  const repos = repositories(repoState);
  await saveReviewedDraft({ repositories: repos, candidateId: 'candidate-1', researchExcerpt: research, profile, now: '2026-10-31T12:00:00Z' });
  const saved = await (repos.candidates as unknown as { get(id: string): Promise<ProfessorCandidate | undefined> }).get('candidate-1');
  assert.ok(saved?.personalizedDraft);
  assert.equal(saved?.status, 'ready-for-review');
  assert.equal(saved?.approvedForSending, false);
  const draft = JSON.parse(saved!.personalizedDraft!) as { personalizationSourceUrl: string; personalizationExcerpt: string };
  assert.equal(draft.personalizationSourceUrl, page);
  assert.equal(draft.personalizationExcerpt, research);
  assert.equal(repoState.savedCandidate?.approvedForSending, false);
});

test('approval workflow invokes the existing source and draft approval gate before saving', async () => {
  const preparedDraft = JSON.stringify({
    candidateId: 'candidate-1', recipientEmail: 'professor@example.edu', subject: 'Prospective MSc applicant interested in systems',
    body: `Dear Professor Example. I read this passage: "${research}". I am interested in discussing your research group. Source: ${page}`,
    personalizationSourceUrl: page, personalizationExcerpt: research, generatedAt: '2026-10-31T00:00:00Z',
  });
  const repoState: { candidate: ProfessorCandidate; savedCandidate?: ProfessorCandidate } = { candidate: candidate({ personalizedDraft: preparedDraft, fitSummary: `Reviewed excerpt "${research}". Source: ${page}` }) };
  const repos = repositories(repoState);
  await approveReviewedDraft({ repositories: repos, candidateId: 'candidate-1', approvedAt: '2026-10-31T12:00:00Z' });
  const approved = await (repos.candidates as unknown as { get(id: string): Promise<ProfessorCandidate | undefined> }).get('candidate-1');
  assert.equal(approved?.status, 'approved');
  assert.equal(approved?.approvedForSending, true);
  assert.match(approved?.approvedDraftHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(repoState.savedCandidate?.approvedDraftHash, approved?.approvedDraftHash);
});

test('program workflow validates imported evidence and leaves assessment until owner approval', async () => {
  const state: { savedProgram?: ProgramRecord; savedAssessment?: { overall: string } } = {};
  const repos = repositories(state);
  await importAndAssessProgram({ repositories: repos, profile, assessedAt: '2026-10-31T12:00:00Z', program: {
    id: 'program-1', institution: 'Example University', name: 'MSc Systems', country: 'Exampleland', intake: 'Fall 2027',
  } });
  assert.equal(state.savedProgram?.id, 'program-1');
  assert.equal(state.savedAssessment, undefined);
  await assert.rejects(importAndAssessProgram({ repositories: repos, profile, program: {
    id: 'bad-program', institution: 'Example', name: 'MSc', country: 'Exampleland', intake: '',
    tuition: { amount: 10, currency: 'USD', period: 'year', evidence: { sourceUrl: 'https://example.edu', checkedAt: '2026-10-31T12:00:00Z', excerpt: 'Tuition is 10 USD yearly.', uncertainty: '', verification: 'unverified' } },
  } }), /verification must be reviewed/);
});

test('opportunity review requires certain official evidence and records owner decisions', async () => {
  let status = '';
  const source = { sourceUrl: 'https://company.example/jobs/graduate', checkedAt: '2026-11-01T00:00:00Z', excerpt: 'Graduate role details.', uncertainty: '', verification: 'reviewed' as const };
  const program = { id: 'company-1', kind: 'company_graduate_program' as const, institution: 'Example Tech', name: 'Graduate role', country: 'Exampleland', intake: '', sourceEvidence: source, lastCheckedAt: source.checkedAt, reviewStatus: 'pending' as const };
  const repos = {
    programs: {
      async get() { return program; },
      async save(value: ProgramRecord) { return { id: value.id, duplicate: false }; },
      async setReviewStatus(_id: string, value: string) { status = value; return true; },
    },
  } as unknown as GradReachRepositories;
  await reviewProgramOpportunity({ repositories: repos, programId: 'company-1', decision: 'approved', reviewedAt: '2026-11-02T00:00:00Z' });
  assert.equal(status, 'approved');
  status = '';
  await assert.rejects(reviewProgramOpportunity({
    repositories: { programs: { async get() { return { ...program, sourceEvidence: { ...source, uncertainty: 'Location is not confirmed.' } }; }, async setReviewStatus() { status = 'approved'; return true; } } } as unknown as GradReachRepositories,
    programId: 'company-1', decision: 'approved',
  }), /evidence is missing or uncertain/);
  assert.equal(status, '');
});

test('duplicate opportunity imports do not create a second assessment', async () => {
  let assessments = 0;
  const sourceEvidence = { sourceUrl: 'https://scholarship.example/award', checkedAt: '2026-11-01T00:00:00Z', excerpt: 'Official award page.', uncertainty: '', verification: 'reviewed' as const };
  const repositories = {
    programs: { async save() { return { id: 'existing-award', duplicate: true }; } },
    assessments: { async save() { assessments++; } },
  } as unknown as GradReachRepositories;
  const result = await importAndAssessProgram({ repositories, profile, program: {
    id: 'second-award-id', kind: 'scholarship', institution: 'Example Foundation', name: 'Award', country: 'Exampleland', intake: '', sourceEvidence,
  } });
  assert.deepEqual(result, { id: 'existing-award', duplicate: true });
  assert.equal(assessments, 0);
});

test('queue and pause workflows reuse the daily planner and repository while never sending mail', async () => {
  const approved = candidate({
    status: 'approved', approvedForSending: true, personalizedDraft: '{}',
    fitSummary: `Reviewed source excerpt "${research}". Source: ${page}`,
  });
  const state: { candidate: ProfessorCandidate; savedControl?: SchedulerControl; savedAttempts?: OutreachAttempt[] } = {
    candidate: approved, savedControl: { paused: false, timeZone: 'UTC', dailyLimit: 5 },
  };
  const repos = repositories(state);
  const queued = await addPlannedAttempts({ repositories: repos, profile, now: '2026-10-31T12:00:00Z' });
  assert.equal(queued, 1);
  assert.equal(state.savedAttempts?.[0]?.state, 'queued');
  assert.equal(state.savedAttempts?.[0]?.recipientEmail, 'professor@example.edu');
  const nowPaused = await toggleOutreachPause({ repositories: repos, profile });
  assert.equal(nowPaused, true);
  assert.equal(state.savedControl?.paused, true);
  assert.equal(await addPlannedAttempts({ repositories: repos, profile, now: '2026-10-31T12:01:00Z' }), 0);
});

test('manual response workflow records statuses without including message contents', async () => {
  const state: { savedOutcome?: unknown } = {};
  const repos = repositories(state);
  const recorded = await recordOutreachOutcome({ repositories: repos, candidateId: 'candidate-1', replyStatus: 'no-response', followUpStatus: 'not-planned', recordedAt: '2026-10-31T12:00:00Z' });
  assert.equal(recorded, true);
  assert.deepEqual(state.savedOutcome, {
    candidateId: 'candidate-1', replyStatus: 'no-response', followUpStatus: 'not-planned', recordedAt: '2026-10-31T12:00:00Z',
  });
  assert.equal(JSON.stringify(state.savedOutcome).includes('messageBody'), false);
});
