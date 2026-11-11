import { approveCandidateForQueue } from '../application/outreach-review.ts';
import { createOutreachDraft } from '../application/outreach-draft.ts';
import { markCandidateEvidenceReviewed } from '../application/research-discovery.ts';
import { assessProgram, parseProgramRecord } from '../domain/program-assessment.ts';
import { parseApplicantProfile, type ApplicantProfile } from '../domain/applicant-profile.ts';
import type { GradReachRepositories } from '../infrastructure/mongo-storage.ts';
import type { OutreachAttempt } from '../domain/outreach-queue.ts';
import { planDailyOutreach } from '../application/daily-outreach-planner.ts';
import { DEFAULT_DISCOVERY_SCHEDULE, validateDiscoverySchedule, type DiscoverySchedule } from '../application/automatic-discovery.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';

export async function getAutomaticDiscoverySettings(repositories: GradReachRepositories) {
  const [profile, savedSchedule, runs, checks] = await Promise.all([
    repositories.profiles.get('primary'), repositories.discoverySchedule.get(), repositories.discoveryRuns.list(20), repositories.discoveryChecks.list(20),
  ]);
  const configuredCountries = profile?.applicant.target.countries ?? [];
  const verifiedCountries = configuredCountries.filter((country) => Object.hasOwn(OFFICIAL_HOSTS_BY_REGION, country));
  return { schedule: savedSchedule ?? { ...DEFAULT_DISCOVERY_SCHEDULE }, verifiedCountries, runs, checks };
}

export async function saveAutomaticDiscoverySettings(repositories: GradReachRepositories, schedule: DiscoverySchedule) {
  const profile = await repositories.profiles.get('primary');
  if (!profile) throw new Error('Profile is unavailable');
  const allowed = profile.applicant.target.countries.filter((country) => Object.hasOwn(OFFICIAL_HOSTS_BY_REGION, country));
  const validated = validateDiscoverySchedule(schedule, allowed);
  await repositories.discoverySchedule.save(validated);
  return validated;
}

export async function toggleAutomaticDiscoveryPause(repositories: GradReachRepositories) {
  const profile = await repositories.profiles.get('primary');
  if (!profile) throw new Error('Profile is unavailable');
  const current = await repositories.discoverySchedule.get() ?? { ...DEFAULT_DISCOVERY_SCHEDULE, timeZone: profile.applicant.target.timezone || 'Africa/Lagos' };
  const next = { ...current, paused: !current.paused };
  await repositories.discoverySchedule.save(next);
  return next.paused;
}

export async function reviewProfessorEvidence(input: {
  repositories: GradReachRepositories;
  candidateId: string;
  reviewedSourceUrls: string[];
  profileUrl: string;
  professorName: string;
}): Promise<void> {
  const candidate = await input.repositories.candidates.get(input.candidateId);
  if (!candidate) throw new Error('Lead not found');
  const reviewed = markCandidateEvidenceReviewed(candidate, input.reviewedSourceUrls, input.profileUrl, input.professorName);
  await input.repositories.candidates.save(reviewed);
}

export async function assessSavedProgram(input: {
  repositories: GradReachRepositories;
  programId: string;
  profile: ApplicantProfile;
  assessedAt?: string;
}): Promise<void> {
  const program = await input.repositories.programs.get(input.programId);
  if (!program) throw new Error('Program not found');
  const assessment = assessProgram({ program, profile: input.profile, ...(input.assessedAt ? { assessedAt: input.assessedAt } : {}) });
  await input.repositories.assessments.save(assessment);
}

export async function importAndAssessProgram(input: {
  repositories: GradReachRepositories;
  profile: ApplicantProfile;
  program: unknown;
  assessedAt?: string;
}): Promise<{ id: string; duplicate: boolean }> {
  const program = parseProgramRecord(input.program);
  const saved = await input.repositories.programs.save(program);
  if (saved.duplicate) return saved;
  if (program.kind === 'msc_program') {
    const assessment = assessProgram({ program, profile: input.profile, ...(input.assessedAt ? { assessedAt: input.assessedAt } : {}) });
    await input.repositories.assessments.save(assessment);
  }
  return saved;
}

export async function reviewProgramOpportunity(input: {
  repositories: GradReachRepositories;
  programId: string;
  decision: 'approved' | 'rejected';
  reviewedAt?: string;
}): Promise<void> {
  const program = await input.repositories.programs.get(input.programId);
  if (!program) throw new Error('Opportunity not found');
  if (input.decision === 'approved') {
    const evidence = [program.sourceEvidence, program.eligibility?.evidence, program.fundingDetails?.evidence, program.compensation?.evidence,
      program.admissions?.evidence, program.english?.evidence, program.tuition?.evidence, program.deadline?.evidence,
      ...(program.fundingRoutes ?? []).map((route) => route.evidence)].filter((item) => item !== undefined);
    if (!program.sourceEvidence || evidence.some((item) => item.verification !== 'reviewed' || item.uncertainty.trim())) {
      throw new Error('Opportunity cannot be approved while official evidence is missing or uncertain');
    }
  }
  await input.repositories.programs.setReviewStatus(input.programId, input.decision, input.reviewedAt ?? new Date().toISOString());
}

export async function saveProfileSettings(input: {
  repositories: GradReachRepositories;
  current: ApplicantProfile;
  settings: Partial<ApplicantProfile['applicant']['target']>;
}): Promise<ApplicantProfile> {
  const profile = parseApplicantProfile({
    ...input.current,
    applicant: {
      ...input.current.applicant,
      target: { ...input.current.applicant.target, ...input.settings },
    },
  });
  await input.repositories.profiles.save('primary', profile);
  const control = await input.repositories.schedulerControl.get() ?? {
    paused: true, timeZone: input.current.applicant.target.timezone, dailyLimit: 5,
  };
  if (control.timeZone !== profile.applicant.target.timezone) {
    await input.repositories.schedulerControl.save({ ...control, timeZone: profile.applicant.target.timezone });
  }
  return profile;
}

/** Saves only the primary applicant profile after the owner explicitly edits its settings. */
export async function saveApplicantProfile(input: {
  repositories: GradReachRepositories;
  edited: ApplicantProfile;
}): Promise<ApplicantProfile> {
  const profile = parseApplicantProfile(input.edited);
  await input.repositories.profiles.save('primary', profile);
  return profile;
}

export async function saveReviewedDraft(input: {
  repositories: GradReachRepositories;
  candidateId: string;
  researchExcerpt: string;
  profile: ApplicantProfile;
  now?: string;
}): Promise<void> {
  const candidate = await input.repositories.candidates.get(input.candidateId);
  if (!candidate) throw new Error('Lead not found');
  const evidence = candidate.discoveryEvidence?.find((item) =>
    item.kind === 'professor-profile' && item.verification === 'reviewed' && item.sourceUrl === candidate.officialProfileUrl,
  );
  if (!evidence) throw new Error('Reviewed professor-profile evidence is required before drafting');
  const draft = createOutreachDraft({
    candidate, profile: input.profile, researchSourceUrl: evidence.sourceUrl,
    researchExcerpt: input.researchExcerpt, ...(input.now ? { now: input.now } : {}),
  });
  candidate.personalizedDraft = JSON.stringify(draft);
  const interest = [...input.profile.applicant.target.researchInterests, ...input.profile.applicant.target.fields].map((item) => item.trim()).find(Boolean);
  candidate.fitSummary = `Reviewed source excerpt "${draft.personalizationExcerpt}" connects to the configured interest "${interest ?? ''}". Source: ${draft.personalizationSourceUrl}`;
  await input.repositories.candidates.save(candidate);
}

export async function approveReviewedDraft(input: {
  repositories: GradReachRepositories;
  candidateId: string;
  approvedAt?: string;
}): Promise<void> {
  const candidate = await input.repositories.candidates.get(input.candidateId);
  if (!candidate) throw new Error('Lead not found');
  const attempts = await input.repositories.attempts.listAll();
  const approved = approveCandidateForQueue(candidate, attempts, input.approvedAt);
  await input.repositories.candidates.save(approved);
}

export async function toggleOutreachPause(input: {
  repositories: GradReachRepositories;
  profile: ApplicantProfile;
}): Promise<boolean> {
  const current = await input.repositories.schedulerControl.get() ?? {
    paused: true, timeZone: input.profile.applicant.target.timezone, dailyLimit: 5,
  };
  const next = { ...current, paused: !current.paused };
  await input.repositories.schedulerControl.save(next);
  return next.paused;
}

export async function addPlannedAttempts(input: {
  repositories: GradReachRepositories;
  profile: ApplicantProfile;
  now?: string;
}): Promise<number> {
  const [candidates, attempts, savedControl] = await Promise.all([
    input.repositories.candidates.list(), input.repositories.attempts.listAll(), input.repositories.schedulerControl.get(),
  ]);
  const control = savedControl ?? { paused: true, timeZone: input.profile.applicant.target.timezone, dailyLimit: 5 };
  const plan = planDailyOutreach({ control, candidates, attempts, now: input.now ?? new Date().toISOString() });
  for (const attempt of plan.attemptsToQueue) await input.repositories.attempts.record(attempt);
  return plan.attemptsToQueue.length;
}

export async function recordOutreachOutcome(input: {
  repositories: GradReachRepositories;
  candidateId: string;
  replyStatus: NonNullable<OutreachAttempt['replyStatus']>;
  followUpStatus: NonNullable<OutreachAttempt['followUpStatus']>;
  followUpScheduledFor?: string;
  recordedAt?: string;
}): Promise<boolean> {
  return input.repositories.attempts.recordManualOutcome({
    candidateId: input.candidateId,
    replyStatus: input.replyStatus,
    followUpStatus: input.followUpStatus,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    ...(input.followUpScheduledFor ? { followUpScheduledFor: input.followUpScheduledFor } : {}),
  });
}
