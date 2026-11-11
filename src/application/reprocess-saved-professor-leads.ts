import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { DiscoveryEvidence, ProfessorCandidate } from '../domain/outreach-queue.ts';
import {
  MAX_SAVED_LEADS_PER_REPROCESS_RUN,
  type SavedLeadContentErrorCode,
  type SavedLeadReprocessDiagnostics,
  type SavedLeadReprocessReason,
  type SavedLeadReprocessReport,
  type SavedLeadReprocessResult,
} from '../domain/saved-lead-reprocessing.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { prepareSavedProfessorEvidence } from './professor-research-evidence.ts';
import {
  DiscoveryPageFetchBudgetReached,
  enrichOfficialCandidate,
  MAX_LINKED_RESEARCH_PAGES_PER_PROFILE,
} from './research-discovery.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';
import type { SafeFailureRecord } from '../infrastructure/sanitized-failure.ts';
import type { ProfessorTraversalDiagnostics } from '../infrastructure/phase3-pilot-diagnostics.ts';

export const MAX_SAVED_LEAD_REPROCESS_FETCHES_PER_RUN = 80;

class LeadResultPersistenceError extends Error {}

export interface SavedLeadReprocessRepositories {
  candidates: {
    list(): Promise<ProfessorCandidate[]>;
    appendValidatedResearchEvidence(input: {
      candidateId: string;
      expectedOfficialProfileUrl?: string;
      expectedProfessorName?: string;
      officialProfileUrl: string;
      professorName: string;
      leadName: string;
      runId: string;
      evidence: DiscoveryEvidence[];
    }): Promise<boolean>;
  };
  profiles: { get(profileId: string): Promise<ApplicantProfile | undefined> };
}

function canonicalUrlKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    return url.toString();
  } catch { return undefined; }
}

function normalizedName(value: string): string {
  return value.replace(/^(?:professor|prof\.?|dr\.?)\s+/i, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function isExactOfficialUrl(value: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function evidenceIdentity(item: DiscoveryEvidence): string {
  return `${item.kind}\n${item.sourceUrl}\n${item.quote ?? ''}`;
}

function safeCount(value: number | undefined, maximum: number): number {
  return Number.isInteger(value) && value! >= 0 ? Math.min(value!, maximum) : 0;
}

function traversalSummary(input?: ProfessorTraversalDiagnostics): SavedLeadReprocessDiagnostics['traversal'] {
  return {
    directoryFetched: input?.directoryPageFetched === true,
    profileLinksConsidered: safeCount(input?.sameHostProfileLinksConsidered, 100),
    profileLinksSelected: safeCount(input?.selectedProfileLinks.length, 10),
    profileLinksFetched: safeCount(input?.sameHostProfileLinksFetched, 10),
    identityEstablished: input?.professorIdentityEstablished === true,
    researchLinksConsidered: safeCount(input?.linkedResearchPagesConsidered, 100),
    researchLinksEligible: safeCount(input?.linkedResearchPagesFound, 100),
    researchLinksSelected: safeCount(input?.linkedResearchPagesSelected.length, 5),
    researchLinksFetched: safeCount(input?.linkedResearchPagesFetched, 5),
    relevantResearchEstablished: input?.relevantOfficialResearchEvidenceEstablished === true,
  };
}

function stageOutcome(reason: SavedLeadReprocessReason): SavedLeadReprocessDiagnostics['stageOutcome'] {
  if (reason === 'evidence_added') return 'enriched';
  if (['protected_state', 'missing_source', 'official_host_rejected'].includes(reason)) return 'eligibility_gate';
  if (reason === 'duplicate_profile') return 'duplicate_check';
  if (reason === 'run_fetch_limit') return 'fetch_limit';
  if (['identity_not_established', 'identity_mismatch'].includes(reason)) return 'identity_check';
  if (['research_evidence_missing', 'no_new_evidence'].includes(reason)) return 'research_check';
  if (reason === 'interest_mismatch') return 'interest_check';
  if (reason === 'record_changed') return 'persistence_check';
  return 'official_page_fetch';
}

function contentErrorCode(failure?: SafeFailureRecord): SavedLeadContentErrorCode | undefined {
  if (failure?.kind !== 'invalid_content') return undefined;
  if (failure.contentTypeIsHtml === false && failure.bodyEmpty === false) return 'unsupported_document';
  if (failure.contentTypeIsHtml === false) return 'unsupported_content_type';
  if (failure.bodyEmpty === true) return 'empty_content';
  return 'invalid_content';
}

function failedStage(
  failure: SafeFailureRecord | undefined,
  traversal: SavedLeadReprocessDiagnostics['traversal'],
): SavedLeadReprocessDiagnostics['failedStage'] | undefined {
  if (!failure) return undefined;
  if (traversal.identityEstablished && traversal.researchLinksSelected > traversal.researchLinksFetched) return 'research_page_fetch';
  if (traversal.profileLinksSelected > traversal.profileLinksFetched) return 'profile_page_fetch';
  return 'official_page_fetch';
}

/** Rechecks saved leads without search and emits one bounded, code-only outcome per stable lead ID. */
export async function reprocessSavedProfessorLeads(input: {
  repositories: SavedLeadReprocessRepositories;
  officialHostsByRegion?: Record<string, readonly string[]>;
  fetchPage(url: string, allowedHosts: string[]): Promise<{ url: string; html: string }>;
  runId: string;
  onLeadResult?(result: SavedLeadReprocessResult): Promise<void>;
  now?: Date;
}): Promise<SavedLeadReprocessReport> {
  const now = input.now ?? new Date();
  const [profile, allCandidates] = await Promise.all([
    input.repositories.profiles.get('primary'),
    input.repositories.candidates.list(),
  ]);
  if (!profile) throw new Error('profile_unavailable');

  const seenIds = new Set<string>();
  const uniqueCandidates = allCandidates.filter((candidate) => {
    if (seenIds.has(candidate.id)) return false;
    seenIds.add(candidate.id);
    return true;
  });
  const candidates = uniqueCandidates.slice(0, MAX_SAVED_LEADS_PER_REPROCESS_RUN);
  const hostsByRegion: Readonly<Record<string, readonly string[]>> = input.officialHostsByRegion ?? OFFICIAL_HOSTS_BY_REGION;
  const researchInterests = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields];
  const counts = { inspected: 0, enriched: 0, unchanged: 0, failed: 0, pageFetches: 0 };
  const reasonCounts: Partial<Record<SavedLeadReprocessReason, number>> = {};
  const fetchBudget = { remaining: MAX_SAVED_LEAD_REPROCESS_FETCHES_PER_RUN };
  let latestTraversal: ProfessorTraversalDiagnostics | undefined;
  let latestFailure: SafeFailureRecord | undefined;
  const knownProfiles = new Map<string, Set<string>>();
  for (const candidate of allCandidates) {
    const key = candidate.officialProfileUrl && canonicalUrlKey(candidate.officialProfileUrl);
    if (!key) continue;
    const owners = knownProfiles.get(key) ?? new Set<string>();
    owners.add(candidate.id);
    knownProfiles.set(key, owners);
  }

  const record = async (result: Omit<SavedLeadReprocessResult, 'diagnostics'>) => {
    const traversal = traversalSummary(latestTraversal);
    const failure = latestFailure;
    const failedAt = result.outcome === 'failed' ? failedStage(failure, traversal) : undefined;
    const contentCode = contentErrorCode(failure);
    const diagnostics: SavedLeadReprocessDiagnostics = {
      stageOutcome: stageOutcome(result.reasonCode),
      traversal,
      ...(failedAt ? { failedStage: failedAt } : {}),
      ...(failure?.statusCode && Number.isInteger(failure.statusCode) && failure.statusCode >= 100 && failure.statusCode <= 599
        ? { httpStatus: failure.statusCode }
        : {}),
      ...(contentCode ? { contentErrorCode: contentCode } : {}),
    };
    const persistedResult: SavedLeadReprocessResult = { ...result, diagnostics };
    if (result.outcome === 'enriched') counts.enriched += 1;
    else if (result.outcome === 'unchanged') counts.unchanged += 1;
    else counts.failed += 1;
    reasonCounts[result.reasonCode] = (reasonCounts[result.reasonCode] ?? 0) + 1;
    try { await input.onLeadResult?.(persistedResult); }
    catch { throw new LeadResultPersistenceError('lead_result_persistence_failed'); }
  };

  for (const original of candidates) {
    latestTraversal = undefined;
    latestFailure = undefined;
    counts.inspected += 1;
    const candidate = structuredClone(original);
    const statusEligible = ['researching', 'needs-evidence', 'ready-for-review'].includes(candidate.status);
    if (!statusEligible || candidate.discoveryReview || candidate.approvedForSending) {
      await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'protected_state' }); continue;
    }
    const region = candidate.searchRegion || candidate.country;
    const hosts = hostsByRegion[region] ?? [];
    const sourceUrl = candidate.discoveryEvidence?.find((item) => item.kind === 'search-result')?.sourceUrl;
    if (!sourceUrl) { await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'missing_source' }); continue; }
    if (!hosts.length || !isExactOfficialUrl(sourceUrl, hosts)) {
      await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'official_host_rejected' }); continue;
    }
    const existingProfileKey = candidate.officialProfileUrl && canonicalUrlKey(candidate.officialProfileUrl);
    if (existingProfileKey && (knownProfiles.get(existingProfileKey)?.size ?? 0) > 1) {
      await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'duplicate_profile' }); continue;
    }
    if (fetchBudget.remaining === 0) {
      await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'run_fetch_limit' }); continue;
    }

    const oldEvidence = candidate.discoveryEvidence ?? [];
    const expectedOfficialProfileUrl = candidate.officialProfileUrl;
    const expectedProfessorName = candidate.professorName;
    try {
      const enriched = await enrichOfficialCandidate(candidate, [...hosts], {
        fetchPage: async (url) => {
          counts.pageFetches += 1;
          return input.fetchPage(url, [...hosts]);
        },
        pageFetchBudget: fetchBudget,
        maxResearchPagesPerProfile: MAX_LINKED_RESEARCH_PAGES_PER_PROFILE,
        followSupplementaryLinks: false,
        now: () => now,
        onProfessorTraversalDiagnostic: (diagnostic) => { latestTraversal = diagnostic; },
        onOfficialPageFailure: (failure) => { latestFailure = failure; },
      });
      if (enriched.leadType !== 'professor_profile' || !enriched.professorName || !enriched.officialProfileUrl) {
        const traversalAfterInspection = latestTraversal as ProfessorTraversalDiagnostics | undefined;
        const reasonCode = traversalAfterInspection?.professorIdentityEstablished && !traversalAfterInspection.relevantOfficialResearchEvidenceEstablished
          ? 'research_evidence_missing'
          : 'identity_not_established';
        await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode }); continue;
      }
      if (candidate.professorName && normalizedName(candidate.professorName) !== normalizedName(enriched.professorName)) {
        await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'identity_mismatch' }); continue;
      }
      if (!isExactOfficialUrl(enriched.officialProfileUrl, hosts)) {
        await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'official_host_rejected' }); continue;
      }
      const freshEvidence = (enriched.discoveryEvidence ?? []).slice(oldEvidence.length);
      const packageResult = prepareSavedProfessorEvidence({ candidate: { ...enriched, discoveryEvidence: freshEvidence }, researchInterests, checkedAt: now.toISOString() });
      if (packageResult.recommendation === 'uncertain') {
        await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'research_evidence_missing' }); continue;
      }
      if (packageResult.recommendation !== 'likely relevant') {
        await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'interest_mismatch' }); continue;
      }
      const profileKey = canonicalUrlKey(enriched.officialProfileUrl);
      if (!profileKey || [...(knownProfiles.get(profileKey) ?? [])].some((id) => id !== candidate.id)) {
        await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'duplicate_profile' }); continue;
      }
      const priorEvidenceKeys = new Set(oldEvidence.map(evidenceIdentity));
      const evidence = freshEvidence.filter((item) => !priorEvidenceKeys.has(evidenceIdentity(item)));
      if (!evidence.length) { await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'no_new_evidence' }); continue; }

      const updated = await input.repositories.candidates.appendValidatedResearchEvidence({
        candidateId: candidate.id,
        ...(expectedOfficialProfileUrl ? { expectedOfficialProfileUrl } : {}),
        ...(expectedProfessorName ? { expectedProfessorName } : {}),
        officialProfileUrl: enriched.officialProfileUrl,
        professorName: enriched.professorName,
        leadName: enriched.name,
        runId: input.runId,
        evidence,
      });
      if (!updated) { await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'record_changed' }); continue; }
      await record({ candidateId: candidate.id, outcome: 'enriched', reasonCode: 'evidence_added' });
      const owners = knownProfiles.get(profileKey) ?? new Set<string>();
      owners.add(candidate.id);
      knownProfiles.set(profileKey, owners);
    } catch (error) {
      if (error instanceof LeadResultPersistenceError) throw error;
      if (error instanceof DiscoveryPageFetchBudgetReached) {
        await record({ candidateId: candidate.id, outcome: 'unchanged', reasonCode: 'run_fetch_limit' }); continue;
      }
      const failure = latestFailure ?? safeFailureRecord(error, sourceUrl);
      latestFailure = failure;
      const kind = failure.kind;
      const allowed = new Set<SavedLeadReprocessReason>(['invalid_content', 'http_status', 'rate_limited', 'network_error', 'disallowed_host', 'rejected_redirect', 'timeout', 'dns_tls']);
      await record({ candidateId: candidate.id, outcome: 'failed', reasonCode: allowed.has(kind as SavedLeadReprocessReason) ? kind as SavedLeadReprocessReason : 'fetch_failed' });
    }
  }

  return {
    counts,
    reasonCounts,
    omittedByLeadLimit: Math.max(0, uniqueCandidates.length - candidates.length),
    duplicateIdentifiersSkipped: allCandidates.length - uniqueCandidates.length,
  };
}
