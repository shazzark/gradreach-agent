import { createHash, randomUUID } from 'node:crypto';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import type { SearchProvider } from '../infrastructure/brave-search-provider.ts';
import { discoverProfessorCandidates, extractOfficialPageExcerpt } from './research-discovery.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';
import { prepareFetchedProfessorEvidence, prepareSavedProfessorEvidence, type ProfessorResearchEvidencePackage } from './professor-research-evidence.ts';
import type { ConfirmedProfessor } from './confirmed-professors.ts';
import { OFFICIAL_INSTITUTION_BY_REGION } from '../config/official-host-allowlist.ts';
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
  /** Finite one-sweep operation; each due slot claims up to five queued countries. */
  sweepOnce?: boolean;
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
  identityConfirmed?: boolean;
  researchEvidenceFound?: boolean;
  interestMatched?: boolean | null;
  savedRecords?: Array<{ kind: 'confirmed_professor' | 'qualified_lead'; id: string }>;
}
export interface DiscoveryRun {
  id: string;
  slotId?: string;
  workerId?: string;
  taskName?: string;
  trigger?: 'scheduled' | 'manual';
  runKind?: 'batch' | 'country';
  scheduledFor: string;
  startedAt: string;
  completedAt?: string;
  country?: string;
  countries?: string[];
  countryOutcomes?: Array<{ country: string; runId: string; state: 'completed' | 'failed'; failureCode?: string; counts: DiscoveryRun['counts'] }>;
  targetingMode?: 'api_country' | 'query_and_host';
  /** Bounded, content-free diagnostics for the request's at most three results. */
  resultDiagnostics?: DiscoveryResultDiagnostic[];
  state: 'running' | 'completed' | 'failed' | 'paused' | 'not_due';
  counts: { searches: number; results: number; saved: number; duplicates: number; rejections: number; fetchFailures: number; inspected: number; inspectionFailures: number; pageFetches?: number; professorsSaved?: number; leadsSaved?: number };
  failureCode?: string;
}

export const DEFAULT_DISCOVERY_SCHEDULE: DiscoverySchedule = {
  enabled: false, paused: true, frequency: 'weekly', dayOfWeek: 1, time: '09:00', timeZone: 'Africa/Lagos', countries: [],
};
export const DISCOVERY_LIMITS = { searchesPerRun: 1, resultsPerSearch: 3, inspectionsPerRun: 5 } as const;

export function validateDiscoverySchedule(value: DiscoverySchedule, configuredCountries: string[]): DiscoverySchedule {
  if (typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean') throw new Error('enabled and paused must be booleans');
  if (value.sweepOnce !== undefined && typeof value.sweepOnce !== 'boolean') throw new Error('sweepOnce must be a boolean');
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
  runs: { list(limit: number): Promise<DiscoveryRun[]>; claim(run: DiscoveryRun): Promise<boolean>; finish(run: DiscoveryRun): Promise<void>; recordDiagnostic?(runId: string, diagnostic: DiscoveryResultDiagnostic): Promise<void>; recordCountryOutcome?(runId: string, outcome: NonNullable<DiscoveryRun['countryOutcomes']>[number]): Promise<void>; recordProgress?(runId: string, counts: DiscoveryRun['counts']): Promise<void>; recoverInterrupted?(before: string, finishedAt: string): Promise<number> };
  checks: { has(candidateId: string, runId: string): Promise<boolean>; list(limit: number): Promise<DiscoveryEvidenceCheck[]>; save(value: DiscoveryEvidenceCheck): Promise<void> };
  confirmedProfessors?: { upsert(value: ConfirmedProfessor & { researchOutcome?: 'matched' | 'evidence_found_no_match' | 'no_research_evidence' | 'fetch_failed' | 'not_evaluated' }): Promise<string> };
}

export const DISCOVERY_COUNTRY_BATCH_SIZE = 5;

/** Picks the next saved-order countries, treating country-level claims as attempts. */
export function selectNextDiscoveryBatch(
  schedule: DiscoverySchedule,
  configuredCountries: string[],
  verifiedCountries: string[],
  runs: DiscoveryRun[],
): string[] {
  const attempted = new Set(runs.flatMap((run) => run.country ? [run.country] : []));
  const ordered = [...new Set([...schedule.countries, ...configuredCountries])];
  return ordered
    .filter((country) => configuredCountries.includes(country) && verifiedCountries.includes(country) && !attempted.has(country))
    .slice(0, DISCOVERY_COUNTRY_BATCH_SIZE);
}

async function advanceDiscoverySchedule(input: {
  repositories: AutomaticDiscoveryRepositories;
  configuredCountries: string[];
  verifiedCountries: string[];
}): Promise<void> {
  const schedule = await input.repositories.schedule.get();
  if (!schedule?.sweepOnce || !schedule.enabled || schedule.paused) return;

  const runs = await input.repositories.runs.list(100);
  const nextBatch = selectNextDiscoveryBatch(schedule, input.configuredCountries, input.verifiedCountries, runs);
  await input.repositories.schedule.save(nextBatch.length > 0
    ? { ...schedule, countries: nextBatch }
    : { ...schedule, enabled: false, paused: true, countries: [] });
}

type AutomaticDiscoveryInput = {
  repositories: AutomaticDiscoveryRepositories;
  configuredCountries: string[];
  verifiedCountries: string[];
  provider: SearchProvider;
  officialHostsByRegion: Record<string, string[]>;
  countryCodesByRegion: Record<string, string>;
  fetchPage(url: string, allowedHosts: string[]): Promise<{ url: string; html: string }>;
  now?: Date;
  workerId?: string;
  taskName?: string;
  onProgress?: (event: JobProgressEvent) => void;
};

function emptyDiscoveryCounts(): DiscoveryRun['counts'] {
  return { searches: 0, results: 0, saved: 0, duplicates: 0, rejections: 0, fetchFailures: 0, inspected: 0, inspectionFailures: 0, pageFetches: 0, professorsSaved: 0, leadsSaved: 0 };
}

function addDiscoveryCounts(target: DiscoveryRun['counts'], source: DiscoveryRun['counts']): void {
  for (const key of Object.keys(target) as Array<keyof DiscoveryRun['counts']>) target[key] = (target[key] ?? 0) + (source[key] ?? 0);
}

const RESULT_REASONS = new Set(['exact_host', 'title', 'excerpt', 'duplicate', 'passed_evidence_gates', 'timeout', 'dns_tls', 'rate_limited', 'http_status', 'rejected_redirect', 'disallowed_host', 'invalid_content', 'network_error', 'mongodb_server_error', 'invalid_request', 'missing_configuration', 'not_professor_profile', 'no_named_professor_identity', 'no_official_research_evidence', 'research_interest_mismatch', 'invalid_search_result', 'duplicate_saved_lead', 'duplicate_official_profile', 'official_page_fetch_failed', 'page_fetch_limit', 'identity_not_established', 'research_evidence_missing', 'passed_all_gates']);
function safeAutomaticDiagnostic(value: DiscoveryResultDiagnostic): DiscoveryResultDiagnostic | undefined {
  if (!Number.isInteger(value.resultNumber) || value.resultNumber < 1 || value.resultNumber > DISCOVERY_LIMITS.resultsPerSearch || !RESULT_REASONS.has(value.reason)) return undefined;
  const savedRecords = (value.savedRecords ?? []).slice(0, 2).flatMap((record) =>
    (record.kind === 'confirmed_professor' || record.kind === 'qualified_lead') && /^[A-Za-z0-9:_-]{1,160}$/.test(record.id)
      ? [{ kind: record.kind, id: record.id }] : []);
  const safeCount = (count: number | undefined, maximum: number) => Number.isInteger(count) && count! >= 0 && count! <= maximum ? count : undefined;
  const selectedProfileLinks = (value.selectedProfileLinks ?? []).slice(0, 10).flatMap((item) => {
    const reasons = item.reasons.filter((reason) => ['named_link_text', 'named_faculty_context', 'profile_url_pattern', 'faculty_card_context', 'profile_label', 'academic_role'].includes(reason)).slice(0, 6);
    return Number.isInteger(item.rank) && item.rank >= 1 && item.rank <= 10 && reasons.length ? [{ rank: item.rank, reasons }] : [];
  });
  const selectedResearchPages = (value.linkedResearchPagesSelected ?? []).slice(0, 5).flatMap((item) => {
    const reasons = item.reasons.filter((reason) => ['research_anchor_text', 'research_url_pattern', 'research_section_context'].includes(reason)).slice(0, 3);
    return Number.isInteger(item.rank) && item.rank >= 1 && item.rank <= 5 && reasons.length ? [{ rank: item.rank, reasons }] : [];
  });
  const safeRejections = <T extends string>(items: Array<{ reason: T; count: number }> | undefined, allowed: readonly T[]) => (items ?? []).slice(0, 2).flatMap((item) =>
    allowed.includes(item.reason) && Number.isInteger(item.count) && item.count >= 1 && item.count <= 100 ? [item] : []);
  return {
    resultNumber: value.resultNumber,
    stage: ['result_validation', 'professor_evidence', 'official_page_fetch', 'duplicate_check', 'interest_match'].includes(value.stage) ? value.stage : 'result_validation',
    reason: value.reason,
    ...(value.observedHostname && /^[a-z0-9.-]{1,253}$/.test(value.observedHostname) ? { observedHostname: value.observedHostname } : {}),
    ...(typeof value.directoryPageFetched === 'boolean' ? { directoryPageFetched: value.directoryPageFetched } : {}),
    ...(safeCount(value.sameHostProfileLinksFound, 100) !== undefined ? { sameHostProfileLinksFound: value.sameHostProfileLinksFound } : {}),
    ...(safeCount(value.sameHostProfileLinksConsidered, 100) !== undefined ? { sameHostProfileLinksConsidered: value.sameHostProfileLinksConsidered } : {}),
    ...(safeCount(value.sameHostProfileLinksFetched, 10) !== undefined ? { sameHostProfileLinksFetched: value.sameHostProfileLinksFetched } : {}),
    ...(selectedProfileLinks.length ? { selectedProfileLinks } : {}),
    ...(typeof value.professorIdentityEstablished === 'boolean' ? { professorIdentityEstablished: value.professorIdentityEstablished } : {}),
    ...(safeCount(value.linkedResearchPagesConsidered, 100) !== undefined ? { linkedResearchPagesConsidered: value.linkedResearchPagesConsidered } : {}),
    ...(safeCount(value.linkedResearchPagesFound, 100) !== undefined ? { linkedResearchPagesFound: value.linkedResearchPagesFound } : {}),
    ...(safeCount(value.linkedResearchPagesFetched, 5) !== undefined ? { linkedResearchPagesFetched: value.linkedResearchPagesFetched } : {}),
    ...(selectedResearchPages.length ? { linkedResearchPagesSelected: selectedResearchPages } : {}),
    ...(safeRejections(value.profileLinkRejections, ['excluded_navigation_or_nonacademic', 'insufficient_profile_signals']).length ? { profileLinkRejections: safeRejections(value.profileLinkRejections, ['excluded_navigation_or_nonacademic', 'insufficient_profile_signals']) } : {}),
    ...(safeRejections(value.researchPageLinkRejections, ['non_research_destination', 'no_research_signal']).length ? { researchPageLinkRejections: safeRejections(value.researchPageLinkRejections, ['non_research_destination', 'no_research_signal']) } : {}),
    ...(typeof value.relevantOfficialResearchEvidenceEstablished === 'boolean' ? { relevantOfficialResearchEvidenceEstablished: value.relevantOfficialResearchEvidenceEstablished } : {}),
    ...(typeof value.identityConfirmed === 'boolean' ? { identityConfirmed: value.identityConfirmed } : {}),
    ...(typeof value.researchEvidenceFound === 'boolean' ? { researchEvidenceFound: value.researchEvidenceFound } : {}),
    ...(typeof value.interestMatched === 'boolean' || value.interestMatched === null ? { interestMatched: value.interestMatched } : {}),
    ...(savedRecords.length ? { savedRecords } : {}),
    ...(Number.isInteger(value.statusCode) && value.statusCode! >= 100 && value.statusCode! <= 599 ? { statusCode: value.statusCode } : {}),
    ...(value.networkCode && /^[A-Z0-9_]{1,40}$/.test(value.networkCode) ? { networkCode: value.networkCode } : {}),
  };
}

async function runDiscoveryCountry(input: AutomaticDiscoveryInput, country: string, slot: string, now: Date, runId: string, slotId = runId): Promise<DiscoveryRun | undefined> {
  const counts = emptyDiscoveryCounts();
  const run: DiscoveryRun = { id: runId, slotId, workerId: input.workerId ?? `pid:${process.pid}`, ...(input.taskName ? { taskName: input.taskName } : {}), trigger: 'scheduled', runKind: 'country', scheduledFor: slot, startedAt: now.toISOString(), country, state: 'running', counts };
  if (!await input.repositories.runs.claim(run)) return undefined;
  const publish = (state: JobProgressState, stage: JobProgressStage, completed: number, total: number) => {
    try { input.onProgress?.(progressEvent(runId, state, stage, completed, total)); } catch { /* Progress listeners cannot change the persisted job outcome. */ }
  };
  let targetingMode: DiscoveryRun['targetingMode'];
  let searchesStarted = 0;
  const resultDiagnostics: DiscoveryResultDiagnostic[] = [];
  let researchInterests: string[] = [];
  let officialPageFetches = 0;
  const seenResults = new Set<number>();
  const persistProgress = () => input.repositories.runs.recordProgress?.(runId, counts);
  const persistDiagnostic = async (diagnostic: DiscoveryResultDiagnostic) => {
    const safe = safeAutomaticDiagnostic(diagnostic);
    if (!safe) return;
    const index = resultDiagnostics.findIndex((item) => item.resultNumber === safe.resultNumber);
    if (index < 0) resultDiagnostics.push(safe);
    else resultDiagnostics[index] = { ...resultDiagnostics[index]!, ...safe };
    resultDiagnostics.sort((a, b) => a.resultNumber - b.resultNumber);
    await input.repositories.runs.recordDiagnostic?.(runId, resultDiagnostics.find((item) => item.resultNumber === safe.resultNumber)!);
  };
  publish('running', 'starting', 0, 1);
  try {
    const profile = await input.repositories.profile.get('primary');
    if (!profile || !profile.applicant.target.countries.includes(country)) throw new Error('profile_country_unavailable');
    researchInterests = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields];
    publish('running', 'searching', 0, DISCOVERY_LIMITS.searchesPerRun);
    const result = await discoverProfessorCandidates({
      profile: { ...profile, applicant: { ...profile.applicant, target: { ...profile.applicant.target, countries: [country] } } },
      provider: input.provider,
      repository: input.repositories.candidates,
      options: {
        officialHostsByRegion: input.officialHostsByRegion,
        countryCodesByRegion: input.countryCodesByRegion,
        oneSearchPerRegion: true,
        oneQueryPerRegion: true,
        maxSearches: DISCOVERY_LIMITS.searchesPerRun,
        resultsPerQuery: DISCOVERY_LIMITS.resultsPerSearch,
        maxPagesPerQuery: 1,
        onSearchTargeting: async (target) => { targetingMode = target.mode; searchesStarted += 1; counts.searches = searchesStarted; await persistProgress(); },
        onResultDiagnostic: async (diagnostic: Phase3ResultDiagnostic) => {
          if (diagnostic.outcome === 'search_started' || diagnostic.outcome === 'redirect_followed' || resultDiagnostics.length >= DISCOVERY_LIMITS.resultsPerSearch) return;
          const resultNumber = diagnostic.resultNumber ?? resultDiagnostics.length + 1;
          const safeDiagnostic = storedDiscoveryResultDiagnostic(diagnostic, resultNumber);
          if (safeDiagnostic) await persistDiagnostic(safeDiagnostic);
        },
        saveOnlyProfessorProfiles: true,
        onOfficialPageFetch: async () => { officialPageFetches += 1; counts.pageFetches = officialPageFetches; await persistProgress(); },
        shouldSaveCandidate: (candidate) => prepareSavedProfessorEvidence({ candidate, researchInterests, checkedAt: now.toISOString() }).recommendation === 'likely relevant',
        onCandidatePreview: async (preview) => {
          if (!seenResults.has(preview.resultNumber)) {
            seenResults.add(preview.resultNumber);
            counts.results += 1;
            if (preview.reasonCode === 'duplicate_saved_lead' || preview.reasonCode === 'duplicate_official_profile') counts.duplicates += 1;
            else if (preview.reasonCode !== 'passed_all_gates') counts.rejections += 1;
            if (preview.reasonCode === 'official_page_fetch_failed') counts.fetchFailures += 1;
          }
          const researchEvidenceFound = preview.supportingResearch.length > 0;
          const interestMatched = preview.reasonCode === 'passed_all_gates' ? true : preview.reasonCode === 'research_interest_mismatch' ? false : null;
          const prior = resultDiagnostics.find((item) => item.resultNumber === preview.resultNumber);
          const stage: DiscoveryResultDiagnostic['stage'] = ['research_interest_mismatch', 'passed_all_gates'].includes(preview.reasonCode) ? 'interest_match' : ['official_page_fetch_failed', 'page_fetch_limit'].includes(preview.reasonCode) ? 'official_page_fetch' : ['duplicate_saved_lead', 'duplicate_official_profile'].includes(preview.reasonCode) ? 'duplicate_check' : preview.reasonCode === 'invalid_search_result' ? 'result_validation' : 'professor_evidence';
          await persistDiagnostic({ ...(prior ?? { resultNumber: preview.resultNumber, stage, reason: preview.reasonCode }), identityConfirmed: preview.identityConfirmed, researchEvidenceFound, interestMatched, savedRecords: prior?.savedRecords ?? [] });
          await persistProgress();
          if (!preview.identityConfirmed || !preview.officialProfileSource || !input.repositories.confirmedProfessors) return;
          const officialResearch = preview.supportingResearch.filter((item) => {
            try { const url = new URL(item.sourceUrl); return url.protocol === 'https:' && (input.officialHostsByRegion[country] ?? []).includes(url.hostname.toLowerCase()); } catch { return false; }
          }).slice(0, 5);
          const stableId = `discovery-${createHash('sha256').update(preview.officialProfileSource).digest('hex').slice(0, 24)}`;
          const fetchFailed = preview.reasonCode === 'official_page_fetch_failed';
          const insertState = await input.repositories.confirmedProfessors.upsert({ stableId, name: preview.name.slice(0, 160), institution: OFFICIAL_INSTITUTION_BY_REGION[country as keyof typeof OFFICIAL_INSTITUTION_BY_REGION] ?? country, country, officialProfileUrl: preview.officialProfileSource, researchEvidence: officialResearch, researchStatus: interestMatched ? 'matched' : researchEvidenceFound ? 'evidence_found_but_not_matched' : fetchFailed ? 'not_evaluated' : 'no_research_evidence', researchStatusExplanation: interestMatched ? 'Official research evidence matched at least one saved interest.' : researchEvidenceFound ? 'Official research evidence was found; no saved interest matched.' : fetchFailed ? 'Identity was confirmed, but the official evidence request failed.' : 'Identity was confirmed on an official profile; no research evidence was found.', researchOutcome: interestMatched ? 'matched' : researchEvidenceFound ? 'evidence_found_no_match' : fetchFailed ? 'fetch_failed' : 'no_research_evidence', duplicate: false, sourceReports: [`automatic-discovery:${slotId}`], localOwnerDecision: 'pending', approved: false, queued: false, sent: false });
          if (insertState === 'inserted') counts.professorsSaved = (counts.professorsSaved ?? 0) + 1;
          const current = resultDiagnostics.find((item) => item.resultNumber === preview.resultNumber)!;
          await persistDiagnostic({ ...current, savedRecords: [...(current.savedRecords ?? []).filter((item) => item.kind !== 'confirmed_professor'), { kind: 'confirmed_professor', id: stableId }] });
        },
        onCandidateSaved: async (candidateId, resultNumber) => {
          const current = resultDiagnostics.find((item) => item.resultNumber === resultNumber);
          if (current) await persistDiagnostic({ ...current, savedRecords: [...(current.savedRecords ?? []).filter((item) => item.kind !== 'qualified_lead'), { kind: 'qualified_lead', id: candidateId }] });
          counts.saved += 1;
          counts.leadsSaved = counts.saved;
          await persistProgress();
        },
        fetchPage: (url) => input.fetchPage(url, input.officialHostsByRegion[country] ?? []),
      },
    });
    Object.assign(counts, {
      searches: result.searches,
      results: result.results,
      saved: result.saved,
      leadsSaved: result.saved,
      professorsSaved: counts.professorsSaved ?? 0,
      pageFetches: officialPageFetches,
      duplicates: result.duplicates,
      rejections: result.rejected,
      fetchFailures: result.officialPageFetchFailures,
    });
    publish('running', 'saving_candidates', 1, 1);
    const [candidates, previousChecks] = await Promise.all([input.repositories.candidates.list(), input.repositories.checks.list(1000)]);
    const latestChecks = new Map<string, string>();
    for (const check of previousChecks.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))) {
      if (!latestChecks.has(check.candidateId)) latestChecks.set(check.candidateId, check.checkedAt);
    }
    candidates.sort((a, b) => (latestChecks.get(a.id) ?? '').localeCompare(latestChecks.get(b.id) ?? ''));
    publish('running', 'persisting_checks', 0, DISCOVERY_LIMITS.inspectionsPerRun);
    await inspectUnreviewed({ ...input, candidates, runId, now, counts,
      researchInterests,
      onInspected: (completed) => publish('running', 'persisting_checks', completed, DISCOVERY_LIMITS.inspectionsPerRun),
    });
    const completed = { ...run, ...(targetingMode ? { targetingMode } : {}), state: 'completed' as const,
      completedAt: new Date().toISOString(), counts, resultDiagnostics };
    await input.repositories.runs.finish(completed);
    publish('completed', 'completed', 1, 1);
    return completed;
  } catch (error) {
    const failure = safeFailureRecord(error);
    const failed = { ...run, ...(targetingMode ? { targetingMode } : {}), state: 'failed' as const,
      completedAt: new Date().toISOString(), failureCode: failure.kind, counts: { ...counts, searches: searchesStarted }, resultDiagnostics };
    await input.repositories.runs.finish(failed);
    publish('failed', 'failed', 1, 1);
    return failed;
  }
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

export async function runAutomaticDiscovery(input: AutomaticDiscoveryInput) {
  const now = input.now ?? new Date();
  const schedule = await input.repositories.schedule.get();
  const current = validateDiscoverySchedule(schedule ?? DEFAULT_DISCOVERY_SCHEDULE, input.configuredCountries);
  const counts = emptyDiscoveryCounts();
  if (!current.enabled || current.paused) return { state: 'paused' as const, counts };
  const slot = discoverySlot(current, now);
  if (!slot) return { state: 'not_due' as const, counts };
  const previousRuns = await input.repositories.runs.list(100);
  if (current.sweepOnce) {
    await input.repositories.runs.recoverInterrupted?.(slot, now.toISOString());
    const recoveredRuns = await input.repositories.runs.list(100);
    const countries = selectNextDiscoveryBatch(current, input.configuredCountries, input.verifiedCountries, recoveredRuns);
    if (countries.length === 0) {
      await input.repositories.schedule.save({ ...current, enabled: false, paused: true, countries: [] });
      return { state: 'paused' as const, counts, countries };
    }
    const runId = `discovery:${slot}`;
    const batch: DiscoveryRun = { id: runId, slotId: slot, workerId: input.workerId ?? `pid:${process.pid}`, ...(input.taskName ? { taskName: input.taskName } : {}), trigger: 'scheduled', runKind: 'batch', scheduledFor: slot, startedAt: now.toISOString(), countries,
      state: 'running', counts };
    // The slot-level claim makes a whole daily batch idempotent across worker restarts.
    if (!await input.repositories.runs.claim(batch)) return { state: 'duplicate' as const, counts, countries: [] };
    const outcomes: NonNullable<DiscoveryRun['countryOutcomes']> = [];
    for (const country of countries) {
      const countryRunId = `${runId}:country:${country}`;
      const countryRun = await runDiscoveryCountry(input, country, slot, now, countryRunId, runId);
      const outcome = { country, runId: countryRunId, state: countryRun?.state === 'completed' ? 'completed' as const : 'failed' as const,
        ...(countryRun?.failureCode ? { failureCode: countryRun.failureCode } : !countryRun ? { failureCode: 'duplicate_country_claim' } : {}),
        counts: countryRun?.counts ?? emptyDiscoveryCounts() };
      outcomes.push(outcome);
      await input.repositories.runs.recordCountryOutcome?.(runId, outcome);
      if (countryRun) addDiscoveryCounts(counts, countryRun.counts);
    }
    const singleTargetingMode = countries.length === 1 && outcomes[0]?.state === 'completed'
      ? (await input.repositories.runs.list(100)).find((run) => run.id === `${runId}:country:${countries[0]}`)?.targetingMode
      : undefined;
    const completed: DiscoveryRun = { ...batch, state: 'completed', completedAt: new Date().toISOString(), counts,
      countryOutcomes: outcomes,
      ...(singleTargetingMode ? { targetingMode: singleTargetingMode } : {}),
    };
    await input.repositories.runs.finish(completed);
    await advanceDiscoverySchedule({ repositories: input.repositories, configuredCountries: input.configuredCountries, verifiedCountries: input.verifiedCountries });
    return completed;
  }

  const countries = current.countries.filter((country) => input.configuredCountries.includes(country) && input.verifiedCountries.includes(country));
  if (countries.length === 0) return { state: 'failed' as const, counts, failureCode: 'no_verified_country' };
  const priorCountry = previousRuns.find((run) => run.state === 'completed')?.country;
  const previousIndex = countries.indexOf(priorCountry ?? '');
  const country = countries[previousIndex < 0 ? 0 : (previousIndex + 1) % countries.length]!;
  const singleRun = await runDiscoveryCountry(input, country, slot, now, `discovery:${slot}`);
  return singleRun ?? { state: 'duplicate' as const, counts };
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
