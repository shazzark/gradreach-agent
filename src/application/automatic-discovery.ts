import { createHash, randomUUID } from 'node:crypto';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import type { SearchProvider } from '../infrastructure/brave-search-provider.ts';
import { discoverProfessorCandidates, extractOfficialPageExcerpt } from './research-discovery.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';
import type { ProfessorResearchEvidencePackage } from './professor-research-evidence.ts';
import { prepareFetchedProfessorEvidence } from './professor-research-evidence.ts';
import type { JobProgressEvent, JobProgressStage, JobProgressState } from '../domain/job-progress.ts';
import { storedDiscoveryResultDiagnostic, type Phase3ResultDiagnostic } from '../infrastructure/phase3-pilot-diagnostics.ts';

type DiscoveryProgress = Pick<JobProgressEvent, 'jobId' | 'kind' | 'state' | 'stage' | 'completed' | 'total' | 'updatedAt'>;

function progressEvent(runId: string, state: JobProgressState, stage: JobProgressStage, completed: number, total: number): DiscoveryProgress {
  // Run IDs include timezone punctuation; expose only a stable opaque identifier to transient clients.
  const jobId = `discovery_${createHash('sha256').update(runId).digest('hex').slice(0, 32)}`;
  return { jobId, kind: 'discovery', state, stage, completed: Math.min(completed, total), total, updatedAt: new Date().toISOString() };
}

export type DiscoveryFrequency = 'daily' | 'weekly';
export interface DiscoverySchedule {
  enabled: boolean;
  paused: boolean;
  frequency: DiscoveryFrequency;
  dayOfWeek: number;
  time: string;
  timeZone: string;
  countries: string[];
}
export interface DiscoveryEvidenceCheck {
  id: string;
  candidateId: string;
  sourceUrl: string;
  checkedAt: string;
  runId: string;
  outcome: 'checked' | 'failed';
  excerpt?: string;
  evidencePackage?: ProfessorResearchEvidencePackage;
  failureCode?: string;
}
export interface DiscoveryResultDiagnostic {
  resultNumber: number;
  stage: 'result_validation' | 'professor_evidence' | 'official_page_fetch' | 'duplicate_check' | 'interest_match';
  reason: string;
  observedHostname?: string;
  directoryPageFetched?: boolean;
  sameHostProfileLinksFound?: number;
  sameHostProfileLinksConsidered?: number;
  sameHostProfileLinksFetched?: number;
  selectedProfileLinks?: Array<{
    rank: number;
    reasons: Array<'named_link_text' | 'named_faculty_context' | 'profile_url_pattern' | 'faculty_card_context' | 'profile_label' | 'academic_role'>;
  }>;
  profileLinkRejections?: Array<{ reason: 'excluded_navigation_or_nonacademic' | 'insufficient_profile_signals'; count: number }>;
  professorIdentityEstablished?: boolean;
  linkedResearchPagesConsidered?: number;
  linkedResearchPagesFound?: number;
  linkedResearchPagesSelected?: Array<{
    rank: number;
    reasons: Array<'research_anchor_text' | 'research_url_pattern' | 'research_section_context'>;
  }>;
  linkedResearchPagesFetched?: number;
  researchPageLinkRejections?: Array<{ reason: 'non_research_destination' | 'no_research_signal'; count: number }>;
  relevantOfficialResearchEvidenceEstablished?: boolean;
  statusCode?: number;
  networkCode?: string;
}
export interface DiscoveryRun {
  id: string;
  scheduledFor: string;
  startedAt: string;
  completedAt?: string;
  country?: string;
  targetingMode?: 'api_country' | 'query_and_host';
  /** Bounded, content-free diagnostics for the request's at most three results. */
  resultDiagnostics?: DiscoveryResultDiagnostic[];
  state: 'running' | 'completed' | 'failed' | 'paused' | 'not_due';
  counts: { searches: number; results: number; saved: number; duplicates: number; rejections: number; fetchFailures: number; inspected: number; inspectionFailures: number };
  failureCode?: string;
}

export const DEFAULT_DISCOVERY_SCHEDULE: DiscoverySchedule = {
  enabled: false, paused: true, frequency: 'weekly', dayOfWeek: 1, time: '09:00', timeZone: 'Africa/Lagos', countries: [],
};
export const DISCOVERY_LIMITS = { searchesPerRun: 1, resultsPerSearch: 3, inspectionsPerRun: 5 } as const;

export function validateDiscoverySchedule(value: DiscoverySchedule, configuredCountries: string[]): DiscoverySchedule {
  if (typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean') throw new Error('enabled and paused must be booleans');
  if (value.frequency !== 'daily' && value.frequency !== 'weekly') throw new Error('frequency must be daily or weekly');
  if (!Number.isInteger(value.dayOfWeek) || value.dayOfWeek < 0 || value.dayOfWeek > 6) throw new Error('dayOfWeek must be 0 through 6');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('time must use HH:mm');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { throw new Error('timeZone must be a valid IANA timezone'); }
  if (!Array.isArray(value.countries) || value.countries.length > 45 || new Set(value.countries).size !== value.countries.length ||
      value.countries.some((country) => !configuredCountries.includes(country))) throw new Error('countries must be unique configured countries');
  if (value.enabled && value.countries.length === 0) throw new Error('an enabled schedule requires at least one configured country');
  return structuredClone(value);
}

function localParts(instant: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = (type: string) => values.find((item) => item.type === type)?.value ?? '';
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: part('hour'), minute: part('minute'), day: weekdays[part('weekday')] };
}

export function discoverySlot(schedule: DiscoverySchedule, now: Date): string | undefined {
  const local = localParts(now, schedule.timeZone);
  if (`${local.hour}:${local.minute}` !== schedule.time || (schedule.frequency === 'weekly' && local.day !== schedule.dayOfWeek)) return undefined;
  return `${local.date}T${schedule.time}[${schedule.timeZone}]`;
}

export interface AutomaticDiscoveryRepositories {
  candidates: { list(): Promise<ProfessorCandidate[]>; save(candidate: ProfessorCandidate): Promise<void> };
  profile: { get(id: string): Promise<ApplicantProfile | undefined> };
  schedule: { get(): Promise<DiscoverySchedule | undefined>; save(value: DiscoverySchedule): Promise<void> };
  runs: { list(limit: number): Promise<DiscoveryRun[]>; claim(run: DiscoveryRun): Promise<boolean>; finish(run: DiscoveryRun): Promise<void> };
  checks: { has(candidateId: string, runId: string): Promise<boolean>; list(limit: number): Promise<DiscoveryEvidenceCheck[]>; save(value: DiscoveryEvidenceCheck): Promise<void> };
}

/** Runs a bounded, search-free evidence refresh for saved undecided leads. */
export async function inspectSavedUnreviewedLeads(input: {
  repositories: AutomaticDiscoveryRepositories;
  verifiedCountries: string[];
  officialHostsByRegion: Record<string, string[]>;
  fetchPage(url: string, allowedHosts: string[]): Promise<{ url: string; html: string }>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const profile = await input.repositories.profile.get('primary');
  if (!profile) throw new Error('profile_unavailable');
  const [candidates, previousChecks] = await Promise.all([
    input.repositories.candidates.list(),
    input.repositories.checks.list(1000),
  ]);
  const latestChecks = new Map<string, string>();
  for (const check of previousChecks.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))) {
    if (!latestChecks.has(check.candidateId)) latestChecks.set(check.candidateId, check.checkedAt);
  }
  candidates.sort((a, b) => (latestChecks.get(a.id) ?? '').localeCompare(latestChecks.get(b.id) ?? ''));
  const pendingBefore = candidates.filter((candidate) =>
    ['researching', 'needs-evidence', 'ready-for-review'].includes(candidate.status) &&
    !candidate.discoveryReview && !candidate.approvedForSending,
  ).length;
  const runId = `manual-inspection:${now.toISOString()}:${randomUUID()}`;
  const counts = { searches: 0, results: 0, saved: 0, duplicates: 0, rejections: 0, fetchFailures: 0, inspected: 0, inspectionFailures: 0 };
  await inspectUnreviewed({
    repositories: input.repositories,
    candidates,
    runId,
    now,
    counts,
    researchInterests: [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields],
    verifiedCountries: input.verifiedCountries,
    officialHostsByRegion: input.officialHostsByRegion,
    fetchPage: input.fetchPage,
  });
  const checks = (await input.repositories.checks.list(1000)).filter((check) => check.runId === runId);
  return {
    runId,
    counts,
    pending: Math.max(0, pendingBefore - counts.inspected),
    matched: checks.filter((check) => check.evidencePackage?.recommendation === 'likely relevant').length,
    uncertain: checks.filter((check) => check.outcome === 'failed' || check.evidencePackage?.recommendation === 'uncertain').length,
    unlikely: checks.filter((check) => check.evidencePackage?.recommendation === 'unlikely').length,
  };
}

export async function runAutomaticDiscovery(input: {
  repositories: AutomaticDiscoveryRepositories;
  configuredCountries: string[];
  verifiedCountries: string[];
  provider: SearchProvider;
  officialHostsByRegion: Record<string, string[]>;
  countryCodesByRegion: Record<string, string>;
  fetchPage(url: string, allowedHosts: string[]): Promise<{ url: string; html: string }>;
  now?: Date;
  onProgress?: (event: JobProgressEvent) => void;
}) {
  const now = input.now ?? new Date();
  const schedule = await input.repositories.schedule.get();
  const current = validateDiscoverySchedule(schedule ?? DEFAULT_DISCOVERY_SCHEDULE, input.configuredCountries);
  const counts = { searches: 0, results: 0, saved: 0, duplicates: 0, rejections: 0, fetchFailures: 0, inspected: 0, inspectionFailures: 0 };
  if (!current.enabled || current.paused) return { state: 'paused' as const, counts };
  const slot = discoverySlot(current, now);
  if (!slot) return { state: 'not_due' as const, counts };
  const countries = current.countries.filter((country) => input.configuredCountries.includes(country) && input.verifiedCountries.includes(country));
  if (countries.length === 0) return { state: 'failed' as const, counts, failureCode: 'no_verified_country' };
  const previousRuns = await input.repositories.runs.list(100);
  const priorCountry = previousRuns.find((run) => run.state === 'completed')?.country;
  const previousIndex = countries.indexOf(priorCountry ?? '');
  const country = countries[previousIndex < 0 ? 0 : (previousIndex + 1) % countries.length]!;
  const runId = `discovery:${slot}`;
  const run: DiscoveryRun = { id: runId, scheduledFor: slot, startedAt: now.toISOString(), country, state: 'running', counts };
  if (!await input.repositories.runs.claim(run)) return { state: 'duplicate' as const, counts };
  const publish = (state: JobProgressState, stage: JobProgressStage, completed: number, total: number) => {
    try { input.onProgress?.(progressEvent(runId, state, stage, completed, total)); } catch { /* Progress listeners cannot change the persisted job outcome. */ }
  };
  let targetingMode: DiscoveryRun['targetingMode'];
  const resultDiagnostics: DiscoveryResultDiagnostic[] = [];
  publish('running', 'starting', 0, 1);
  try {
    const profile = await input.repositories.profile.get('primary');
    if (!profile || !profile.applicant.target.countries.includes(country)) throw new Error('profile_country_unavailable');
    const repository = input.repositories.candidates;
    publish('running', 'searching', 0, DISCOVERY_LIMITS.searchesPerRun);
    const result = await discoverProfessorCandidates({
      profile: { ...profile, applicant: { ...profile.applicant, target: { ...profile.applicant.target, countries: [country] } } },
      provider: input.provider,
      repository,
      options: { officialHostsByRegion: input.officialHostsByRegion, countryCodesByRegion: input.countryCodesByRegion,
        oneSearchPerRegion: true, maxSearches: DISCOVERY_LIMITS.searchesPerRun, resultsPerQuery: DISCOVERY_LIMITS.resultsPerSearch,
        onSearchTargeting: (target) => { targetingMode = target.mode; },
        onResultDiagnostic: (diagnostic: Phase3ResultDiagnostic) => {
          if (diagnostic.outcome === 'search_started' || diagnostic.outcome === 'redirect_followed' || resultDiagnostics.length >= DISCOVERY_LIMITS.resultsPerSearch) return;
          const resultNumber = diagnostic.resultNumber ?? resultDiagnostics.length + 1;
          const safeDiagnostic = storedDiscoveryResultDiagnostic(diagnostic, resultNumber);
          if (safeDiagnostic && !resultDiagnostics.some((item) => item.resultNumber === safeDiagnostic.resultNumber)) {
            resultDiagnostics.push(safeDiagnostic);
            resultDiagnostics.sort((left, right) => left.resultNumber - right.resultNumber);
          }
        },
        saveOnlyProfessorProfiles: true, fetchPage: (url) => input.fetchPage(url, input.officialHostsByRegion[country] ?? []) },
    });
    Object.assign(counts, { searches: result.searches, results: result.saved + result.duplicates + result.rejected,
      saved: result.saved, duplicates: result.duplicates, rejections: result.rejected, fetchFailures: result.officialPageFetchFailures });
    publish('running', 'saving_candidates', 1, 1);
    const [candidates, previousChecks] = await Promise.all([input.repositories.candidates.list(), input.repositories.checks.list(1000)]);
    const latestChecks = new Map<string, string>();
    for (const check of previousChecks.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))) {
      if (!latestChecks.has(check.candidateId)) latestChecks.set(check.candidateId, check.checkedAt);
    }
    candidates.sort((a, b) => (latestChecks.get(a.id) ?? '').localeCompare(latestChecks.get(b.id) ?? ''));
    publish('running', 'persisting_checks', 0, DISCOVERY_LIMITS.inspectionsPerRun);
    await inspectUnreviewed({ ...input, candidates, runId, now, counts, researchInterests: [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields],
      onInspected: (completed) => publish('running', 'persisting_checks', completed, DISCOVERY_LIMITS.inspectionsPerRun) });
    const completed = { ...run, ...(targetingMode ? { targetingMode } : {}), state: 'completed' as const, completedAt: new Date().toISOString(), counts, resultDiagnostics };
    await input.repositories.runs.finish(completed);
    publish('completed', 'completed', 1, 1);
    return completed;
  } catch (error) {
    const failure = safeFailureRecord(error);
    const failed = { ...run, ...(targetingMode ? { targetingMode } : {}), state: 'failed' as const, completedAt: new Date().toISOString(), failureCode: failure.kind, counts, resultDiagnostics };
    await input.repositories.runs.finish(failed);
    publish('failed', 'failed', 1, 1);
    return failed;
  }
}

async function inspectUnreviewed(input: {
  repositories: AutomaticDiscoveryRepositories;
  candidates: ProfessorCandidate[];
  runId: string;
  now: Date;
  counts: DiscoveryRun['counts'];
  researchInterests: string[];
  verifiedCountries: string[];
  officialHostsByRegion: Record<string, readonly string[]>;
  fetchPage(url: string, hosts: string[]): Promise<{ url: string; html: string }>;
  onInspected?: (completed: number) => void;
}) {
  for (const candidate of input.candidates) {
    if (input.counts.inspected >= DISCOVERY_LIMITS.inspectionsPerRun) break;
    if (!['researching', 'needs-evidence', 'ready-for-review'].includes(candidate.status) || candidate.discoveryReview || candidate.approvedForSending) continue;
    const region = candidate.searchRegion || candidate.country;
    if (!input.verifiedCountries.includes(region) || await input.repositories.checks.has(candidate.id, input.runId)) continue;
    const sourceUrl = candidate.officialProfileUrl ?? candidate.discoveryEvidence?.find((item) => item.kind === 'professor-profile' || item.kind === 'official-page')?.sourceUrl;
    if (!sourceUrl) continue;
    const hosts = input.officialHostsByRegion[region] ?? [];
    let parsedUrl: URL;
    try { parsedUrl = new URL(sourceUrl); } catch { input.counts.inspectionFailures += 1; continue; }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || !hosts.includes(parsedUrl.hostname)) {
      input.counts.inspectionFailures += 1;
      continue;
    }
    const id = `${input.runId}:${candidate.id}`;
    try {
      const page = await input.fetchPage(sourceUrl, [...hosts]);
      const excerpt = extractOfficialPageExcerpt(page.html).slice(0, 2000);
      const evidencePackage = prepareFetchedProfessorEvidence({ candidate, sourceUrl: page.url, html: page.html, researchInterests: input.researchInterests, checkedAt: input.now.toISOString() });
      await input.repositories.checks.save({ id, candidateId: candidate.id, sourceUrl: page.url, checkedAt: input.now.toISOString(), runId: input.runId, outcome: 'checked', excerpt, evidencePackage });
      input.counts.inspected += 1;
      input.onInspected?.(input.counts.inspected);
    } catch (error) {
      const failure = safeFailureRecord(error, sourceUrl);
      await input.repositories.checks.save({ id, candidateId: candidate.id, sourceUrl, checkedAt: input.now.toISOString(), runId: input.runId, outcome: 'failed', failureCode: failure.kind });
      input.counts.inspected += 1;
      input.counts.inspectionFailures += 1;
      input.onInspected?.(input.counts.inspected);
    }
  }
}
