'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { acceptDiscoveredProfessorLead, rejectDiscoveredProfessorLead } from '../src/application/discovery-lead-review.ts';
import { triageCandidateEvidence } from '../src/application/evidence-triage.ts';
import { assessSavedProgram, importAndAssessProgram, approveReviewedDraft, addPlannedAttempts, recordOutreachOutcome, reviewProfessorEvidence, saveApplicantProfile, saveReviewedDraft, toggleOutreachPause, saveAutomaticDiscoverySettings, toggleAutomaticDiscoveryPause } from '../src/web/owner-workflows.ts';
import { DEFAULT_DISCOVERY_SCHEDULE, type DiscoverySchedule } from '../src/application/automatic-discovery.ts';
import { withOwnerData } from '../src/web/owner-data.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';
import { discoverProfessorCandidates, fetchOfficialPage } from '../src/application/research-discovery.ts';
import { BraveSearchProvider } from '../src/infrastructure/brave-search-provider.ts';
import { GeminiDraftProvider } from '../src/infrastructure/gemini-draft-provider.ts';
import { createEmptyApplicantProfile, parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import { persistPreparedProfessorEvidence, prepareSavedProfessorEvidence } from '../src/application/professor-research-evidence.ts';
import { readProfilePreferenceList } from '../src/application/profile-preferences.ts';
import { publishJobProgress } from '../src/infrastructure/job-progress-bus.ts';
import { appendPhase3ResultDiagnostic } from '../src/infrastructure/phase3-pilot-diagnostics.ts';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== 'string') throw new Error('Invalid form submission');
  return value.trim();
}

function list(form: FormData, name: string): string[] {
  return text(form, name).split(',').map((value) => value.trim()).filter(Boolean);
}

function safeId(value: string): string {
  if (!value || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid record identifier');
  return value;
}

function actionRedirect(path: string, state: 'saved' | 'unavailable' = 'saved'): never {
  revalidatePath(path);
  redirect(`${path}?state=${state}`);
}

function handleActionFailure(error: unknown, path: string): never {
  if (error instanceof Error && error.name === 'OwnerAccessDenied') throw new Error('Owner access is required');
  return actionRedirect(path, 'unavailable');
}

export async function signOutAction(): Promise<void> {
  const { requireOwner } = await import('../src/web/owner-data.ts');
  const { signOut } = await import('../auth.ts');
  await requireOwner();
  await signOut({ redirectTo: '/sign-in' });
}

export async function saveDiscoveryScheduleAction(form: FormData): Promise<never> {
  try {
    await withOwnerData(async (repositories) => {
      const profile = await repositories.profiles.get('primary');
      if (!profile) throw new Error('Profile is unavailable');
      const day = Number(text(form, 'dayOfWeek'));
      const schedule: DiscoverySchedule = {
        ...DEFAULT_DISCOVERY_SCHEDULE,
        enabled: form.get('enabled') === 'on',
        paused: (await repositories.discoverySchedule.get())?.paused ?? true,
        frequency: text(form, 'frequency') as DiscoverySchedule['frequency'],
        dayOfWeek: day,
        time: text(form, 'time'),
        timeZone: text(form, 'timeZone'),
        countries: form.getAll('countries').filter((value): value is string => typeof value === 'string'),
      };
      await saveAutomaticDiscoverySettings(repositories, schedule);
    });
  } catch (error) { return handleActionFailure(error, '/discovery'); }
  return actionRedirect('/discovery');
}

export async function toggleDiscoveryPauseAction(): Promise<never> {
  try { await withOwnerData((repositories) => toggleAutomaticDiscoveryPause(repositories)); }
  catch (error) { return handleActionFailure(error, '/discovery'); }
  return actionRedirect('/discovery');
}

export async function reviewEvidenceAction(form: FormData): Promise<never> {
  const id = safeId(text(form, 'candidateId'));
  try {
    await withOwnerData(async (repositories) => {
      const candidate = await repositories.candidates.get(id);
      if (!candidate) throw new Error('Lead not found');
      const evidence = candidate.discoveryEvidence ?? [];
      const selected = (name: string) => form.getAll(name).map((value) => Number(value));
      const profileIndex = Number(text(form, 'profileIndex'));
      const reviewedIndices = selected('reviewedSourceIndex');
      if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex >= evidence.length ||
          reviewedIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= evidence.length)) throw new Error('Invalid evidence selection');
      const sourceUrl = evidence[profileIndex]?.sourceUrl;
      if (!sourceUrl) throw new Error('Invalid profile source');
      await reviewProfessorEvidence({
        repositories, candidateId: id,
        reviewedSourceUrls: reviewedIndices.map((index) => evidence[index]!.sourceUrl),
        profileUrl: sourceUrl, professorName: text(form, 'professorName'),
      });
    });
  } catch (error) { return handleActionFailure(error, '/leads'); }
  return actionRedirect('/leads');
}

export async function acceptLeadAction(form: FormData): Promise<never> {
  const id = safeId(text(form, 'candidateId'));
  try {
    await withOwnerData(async (repositories) => {
      const candidate = await repositories.candidates.get(id);
      if (!candidate) throw new Error('Lead not found');
      await repositories.candidates.save(acceptDiscoveredProfessorLead(candidate));
    });
  } catch (error) { return handleActionFailure(error, '/leads'); }
  return actionRedirect('/leads');
}

export async function rejectLeadAction(form: FormData): Promise<never> {
  const id = safeId(text(form, 'candidateId'));
  try {
    await withOwnerData(async (repositories) => {
      const candidate = await repositories.candidates.get(id);
      if (!candidate) throw new Error('Lead not found');
      await repositories.candidates.save(rejectDiscoveredProfessorLead(candidate));
    });
  } catch (error) { return handleActionFailure(error, '/leads'); }
  return actionRedirect('/leads');
}

export async function runDiscoveryAction(form: FormData): Promise<never> {
  const region = text(form, 'region');
  const hosts = OFFICIAL_HOSTS_BY_REGION[region as keyof typeof OFFICIAL_HOSTS_BY_REGION];
  if (!hosts) return actionRedirect('/leads', 'unavailable');
  const jobId = randomUUID();
  let started = false;
  try {
    await withOwnerData(async (repositories) => {
      const profile = await repositories.profiles.get('primary');
      if (!profile || !profile.applicant.target.countries.includes(region)) throw new Error('Region is not configured');
      const knownIds = new Set((await repositories.candidates.list()).map((candidate) => candidate.id));
      started = true;
      publishJobProgress({ jobId, kind: 'discovery', state: 'running', stage: 'starting', updatedAt: new Date().toISOString() });
      await discoverProfessorCandidates({
        profile: { ...profile, applicant: { ...profile.applicant, target: { ...profile.applicant.target, countries: [region] } } },
        provider: new BraveSearchProvider(),
        repository: repositories.candidates,
        options: {
          officialHostsByRegion: { [region]: [...hosts] }, oneSearchPerRegion: true,
          resultsPerQuery: 3, maxSearches: 1,
          saveOnlyProfessorProfiles: true,
          onSearchTargeting: ({ country, mode }) => appendPhase3ResultDiagnostic({
            stage: 'brave_search', country, hostname: null, outcome: 'search_started', rejectionReasons: [], targetingMode: mode,
          }),
          shouldSaveCandidate: (candidate) => prepareSavedProfessorEvidence({
            candidate,
            researchInterests: [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields],
            checkedAt: new Date().toISOString(),
          }).recommendation === 'likely relevant',
          fetchPage: (url) => fetchOfficialPage(url, [...hosts]),
        },
      });
      const retrievedAt = new Date().toISOString();
      const freshCandidates = (await repositories.candidates.list()).filter((candidate) =>
        !knownIds.has(candidate.id) && (candidate.searchRegion || candidate.country) === region && candidate.leadType === 'professor_profile',
      );
      await persistPreparedProfessorEvidence({
        candidates: freshCandidates,
        researchInterests: [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields],
        checkedAt: retrievedAt,
        runId: `manual:${retrievedAt}`,
        repository: repositories.discoveryChecks,
      });
      publishJobProgress({
        jobId, kind: 'discovery', state: 'completed', stage: 'completed', completed: 1, total: 1,
        updatedAt: new Date().toISOString(),
      });
    });
  } catch (error) {
    if (started) publishJobProgress({ jobId, kind: 'discovery', state: 'failed', stage: 'failed', updatedAt: new Date().toISOString() });
    return handleActionFailure(error, '/leads');
  }
  return actionRedirect('/leads');
}

export async function runEvidenceTriageAction(form: FormData): Promise<never> {
  const ids = form.getAll('candidateId').filter((item): item is string => typeof item === 'string').map(safeId);
  if (ids.length < 1 || ids.length > 11 || new Set(ids).size !== ids.length) return actionRedirect('/leads', 'unavailable');
  try {
    await withOwnerData(async (repositories) => {
      const [profile, candidates] = await Promise.all([repositories.profiles.get('primary'), Promise.all(ids.map((id) => repositories.candidates.get(id)))]);
      if (!profile || candidates.some((candidate) => !candidate)) throw new Error('Selected leads are unavailable');
      await triageCandidateEvidence({
        candidates: candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined),
        researchCriteria: [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields],
        officialHostsByRegion: OFFICIAL_HOSTS_BY_REGION,
        provider: new GeminiDraftProvider(),
        repository: repositories.evidenceTriage,
      });
    });
  } catch (error) { return handleActionFailure(error, '/leads'); }
  return actionRedirect('/leads');
}

export async function saveProfileAction(form: FormData): Promise<never> {
  try {
    await withOwnerData(async (repositories) => {
      const current = await repositories.profiles.get('primary');
      const base = current ?? createEmptyApplicantProfile();
      const optionalNumber = (name: string): number | null => {
        const value = text(form, name);
        if (!value) return null;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${name}`);
        return parsed;
      };
      const graduationYear = optionalNumber('graduationYear');
      if (graduationYear !== null && (!Number.isInteger(graduationYear) || graduationYear < 1900 || graduationYear > 2200)) throw new Error('Invalid graduation year');
      const edited = parseApplicantProfile({
        ...base,
        applicant: {
          ...base.applicant,
          fullName: text(form, 'fullName'), email: text(form, 'email'), phone: text(form, 'phone'),
          nationality: text(form, 'nationality'), currentLocation: text(form, 'currentLocation'),
          degree: {
            ...base.applicant.degree,
            title: text(form, 'degreeTitle'), institution: text(form, 'degreeInstitution'), country: text(form, 'degreeCountry'),
            graduationYear, classification: text(form, 'classification'), gpa: optionalNumber('gpa'),
            gpaScale: optionalNumber('gpaScale'), gradingScaleDocument: text(form, 'gradingScaleDocument'),
          },
          target: {
            ...base.applicant.target, degreeLevel: 'masters', fields: list(form, 'fields'), countries: readProfilePreferenceList(form, 'targetCountry', 'countries'),
            intake: text(form, 'intake'), researchInterests: readProfilePreferenceList(form, 'researchInterest', 'researchInterests'),
            fundingTypes: list(form, 'fundingTypes'), timezone: text(form, 'timezone'),
            maxAnnualTuition: optionalNumber('maxAnnualTuition'), tuitionCurrency: text(form, 'tuitionCurrency'),
          },
          englishEvidence: {
            testStatus: text(form, 'testStatus'), testName: text(form, 'testName'), score: text(form, 'testScore'),
            testDate: text(form, 'testDate'), mediumOfInstructionLetter: text(form, 'mediumOfInstructionLetter'),
          },
          documents: {
            academicCvPath: text(form, 'academicCvPath'), transcriptPath: text(form, 'transcriptPath'),
            portfolioUrl: text(form, 'portfolioUrl'), githubUrl: text(form, 'githubUrl'), projectUrls: list(form, 'projectUrls'),
          },
        },
      });
      await saveApplicantProfile({ repositories, edited });
    });
  } catch (error) { return handleActionFailure(error, '/profile'); }
  return actionRedirect('/profile');
}

export async function importProgramAction(form: FormData): Promise<never> {
  try {
    const source = text(form, 'programJson');
    if (source.length > 100_000) throw new Error('Program record is too large');
    const program = JSON.parse(source) as unknown;
    await withOwnerData(async (repositories) => {
      const profile = await repositories.profiles.get('primary');
      if (!profile) throw new Error('Profile is unavailable');
      await importAndAssessProgram({ repositories, profile, program });
    });
  } catch (error) { return handleActionFailure(error, '/programs'); }
  return actionRedirect('/programs');
}

export async function reassessProgramAction(form: FormData): Promise<never> {
  const id = safeId(text(form, 'programId'));
  try {
    await withOwnerData(async (repositories) => {
      const profile = await repositories.profiles.get('primary');
      if (!profile) throw new Error('Profile is unavailable');
      await assessSavedProgram({ repositories, programId: id, profile });
    });
  } catch (error) { return handleActionFailure(error, '/programs'); }
  return actionRedirect('/programs');
}

export async function saveDraftAction(form: FormData): Promise<never> {
  const id = safeId(text(form, 'candidateId'));
  try {
    await withOwnerData(async (repositories) => {
      const profile = await repositories.profiles.get('primary');
      if (!profile) throw new Error('Profile is unavailable');
      await saveReviewedDraft({ repositories, candidateId: id, researchExcerpt: text(form, 'researchExcerpt'), profile });
    });
  } catch (error) { return handleActionFailure(error, '/drafts'); }
  return actionRedirect('/drafts');
}

export async function approveDraftAction(form: FormData): Promise<never> {
  const id = safeId(text(form, 'candidateId'));
  try { await withOwnerData((repositories) => approveReviewedDraft({ repositories, candidateId: id })); }
  catch (error) { return handleActionFailure(error, '/drafts'); }
  return actionRedirect('/drafts');
}

export async function togglePauseAction(): Promise<never> {
  try {
    await withOwnerData(async (repositories) => {
      const profile = await repositories.profiles.get('primary');
      if (!profile) throw new Error('Profile is unavailable');
      await toggleOutreachPause({ repositories, profile });
    });
  } catch (error) { return handleActionFailure(error, '/outreach'); }
  return actionRedirect('/outreach');
}

export async function queueApprovedDraftsAction(): Promise<never> {
  try {
    await withOwnerData(async (repositories) => {
      const profile = await repositories.profiles.get('primary');
      if (!profile) throw new Error('Profile is unavailable');
      await addPlannedAttempts({ repositories, profile });
    });
  } catch (error) { return handleActionFailure(error, '/outreach'); }
  return actionRedirect('/outreach');
}

export async function recordOutcomeAction(form: FormData): Promise<never> {
  const id = safeId(text(form, 'candidateId'));
  const replyStatus = text(form, 'replyStatus');
  const followUpStatus = text(form, 'followUpStatus');
  if (!['replied', 'no-response', 'declined'].includes(replyStatus) || !['not-planned', 'due', 'scheduled', 'closed'].includes(followUpStatus)) return actionRedirect('/outreach', 'unavailable');
  const followUpScheduledFor = text(form, 'followUpScheduledFor');
  try {
    await withOwnerData((repositories) => recordOutreachOutcome({
      repositories, candidateId: id,
      replyStatus: replyStatus as 'replied' | 'no-response' | 'declined',
      followUpStatus: followUpStatus as 'not-planned' | 'due' | 'scheduled' | 'closed',
      ...(followUpScheduledFor ? { followUpScheduledFor } : {}),
    }));
  } catch (error) { return handleActionFailure(error, '/outreach'); }
  return actionRedirect('/outreach');
}
