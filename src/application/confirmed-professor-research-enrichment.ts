import { createHash } from 'node:crypto';
import { canonicalizeSourceUrl, DiscoveryPageFetchBudgetReached, enrichOfficialCandidate, fetchOfficialPage, MAX_LINKED_RESEARCH_PAGES_PER_PROFILE } from './research-discovery.ts';
import { matchingResearchInterests, researchQuoteNamesOtherLead } from './professor-research-evidence.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import type { ProfessorTraversalDiagnostics } from '../infrastructure/phase3-pilot-diagnostics.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

export type ConfirmedProfessorResearchOutcome = 'matched' | 'evidence_found_no_match' | 'no_research_evidence' | 'fetch_failed' | 'not_evaluated';

export interface ConfirmedProfessorResearchTarget {
  stableId: string;
  name: string;
  institution: string;
  country: string;
  officialProfileUrl: string;
}

export interface ProfessorResearchTraversalSummary {
  directoryFetched: boolean;
  profileLinksConsidered: number;
  profileLinksSelected: number;
  profileLinksFetched: number;
  identityEstablished: boolean;
  researchLinksConsidered: number;
  researchLinksSelected: number;
  researchLinksFetched: number;
  relevantResearchEvidenceEstablished: boolean;
  pageFetches: number;
  httpStatuses: number[];
  contentTypes: string[];
}

export interface ConfirmedProfessorResearchResult extends ConfirmedProfessorResearchTarget {
  outcome: ConfirmedProfessorResearchOutcome;
  reasonCode: 'interest_match' | 'interest_not_matched' | 'no_research_evidence' | 'fetch_failed' | 'fetch_budget_reached' | 'identity_not_reconfirmed';
  interestMatch: 'matched' | 'not_matched' | 'not_evaluated';
  explanation: string;
  researchEvidence?: { quote: string; sourceUrl: string };
  failureCodes: string[];
  traversal: ProfessorResearchTraversalSummary;
  checkedAt: string;
}

export interface ConfirmedProfessorResearchReport {
  schemaVersion: 1;
  generatedAt: string;
  totalProfessors: number;
  completedProfessors: number;
  professors: ConfirmedProfessorResearchResult[];
}

const TERMINAL_OUTCOMES = new Set<ConfirmedProfessorResearchOutcome>(['matched', 'evidence_found_no_match', 'no_research_evidence']);
const SAFE_FETCH_FAILURE_CODES = new Set(['timeout', 'dns_tls', 'rate_limited', 'http_status', 'rejected_redirect', 'disallowed_host', 'invalid_content', 'network_error', 'invalid_request', 'missing_configuration']);

export function isResearchEnrichmentComplete(result: ConfirmedProfessorResearchResult | undefined): boolean {
  return Boolean(result && TERMINAL_OUTCOMES.has(result.outcome));
}

export function resumableResearchTargets<T extends ConfirmedProfessorResearchTarget>(
  targets: T[],
  saved: ConfirmedProfessorResearchResult[],
): T[] {
  const completed = new Set(saved.filter(isResearchEnrichmentComplete).map((item) => item.stableId));
  return targets.filter((target) => !completed.has(target.stableId));
}

/** Deduplicates report-derived identities by canonical official profile and normalized person/institution. */
export function deduplicateResearchTargets<T extends ConfirmedProfessorResearchTarget>(targets: T[]): T[] {
  const seenProfiles = new Set<string>();
  const seenPeople = new Set<string>();
  const unique: T[] = [];
  for (const target of targets) {
    let profile: string;
    try {
      const url = new URL(target.officialProfileUrl);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      profile = canonicalizeSourceUrl(url.toString());
    } catch { continue; }
    const person = `${normalizeIdentity(target.name)}|${normalizeIdentity(target.institution)}`;
    if (seenProfiles.has(profile) || seenPeople.has(person)) continue;
    seenProfiles.add(profile);
    seenPeople.add(person);
    const displayUrl = new URL(profile);
    displayUrl.search = '';
    displayUrl.hash = '';
    unique.push({ ...target, stableId: target.stableId || stableId(profile), officialProfileUrl: displayUrl.toString() });
  }
  return unique;
}

export function createEmptyTraversalSummary(): ProfessorResearchTraversalSummary {
  return {
    directoryFetched: false, profileLinksConsidered: 0, profileLinksSelected: 0, profileLinksFetched: 0,
    identityEstablished: false, researchLinksConsidered: 0, researchLinksSelected: 0, researchLinksFetched: 0,
    relevantResearchEvidenceEstablished: false, pageFetches: 0, httpStatuses: [], contentTypes: [],
  };
}

export function classifyResearchOutcome(input: {
  identityEstablished: boolean;
  expectedIdentityConfirmed: boolean;
  relevantResearchEvidenceEstablished: boolean;
  quote?: string;
  matched: boolean;
  failedFetches: number;
  budgetReached: boolean;
}): Pick<ConfirmedProfessorResearchResult, 'outcome' | 'reasonCode' | 'interestMatch' | 'explanation'> {
  if (input.budgetReached) return {
    outcome: 'not_evaluated', reasonCode: 'fetch_budget_reached', interestMatch: 'not_evaluated',
    explanation: 'The official-page inspection budget was reached before this professor could be fully evaluated.',
  };
  if (input.failedFetches > 0) return {
    outcome: 'fetch_failed', reasonCode: 'fetch_failed', interestMatch: 'not_evaluated',
    explanation: 'At least one selected official research page could not be inspected, so research fit remains unevaluated.',
  };
  if (!input.identityEstablished || !input.expectedIdentityConfirmed) return {
    outcome: 'not_evaluated', reasonCode: 'identity_not_reconfirmed', interestMatch: 'not_evaluated',
    explanation: 'The fetched official profile did not reconfirm the saved individual identity and academic role.',
  };
  if (!input.quote || !input.relevantResearchEvidenceEstablished) return {
    outcome: 'no_research_evidence', reasonCode: 'no_research_evidence', interestMatch: 'not_evaluated',
    explanation: 'The inspected official profile and selected official research pages did not establish attributable research evidence.',
  };
  if (input.matched) return {
    outcome: 'matched', reasonCode: 'interest_match', interestMatch: 'matched',
    explanation: 'Verified official research evidence matched at least one saved research interest.',
  };
  return {
    outcome: 'evidence_found_no_match', reasonCode: 'interest_not_matched', interestMatch: 'not_matched',
    explanation: 'Verified official research evidence was found, but it did not match any saved research interest.',
  };
}

export function evaluateResearchInterestMatch(quote: string, interests: string[]): boolean {
  return matchingResearchInterests(quote, interests).length > 0;
}

/** Runs the existing exact-host identity and linked-research traversal without saving candidates. */
export async function enrichConfirmedProfessorResearch(input: {
  target: ConfirmedProfessorResearchTarget;
  interests: string[];
  checkedAt: string;
  pageFetchBudget: { remaining: number };
  fetchImpl?: typeof fetch;
}): Promise<ConfirmedProfessorResearchResult> {
  const target = input.target;
  const hosts = (OFFICIAL_HOSTS_BY_REGION as Record<string, readonly string[]>)[target.country] ?? [];
  const traversal = createEmptyTraversalSummary();
  const failures = new Set<string>();
  const statuses = new Set<number>();
  const contentTypes = new Set<string>();
  let observedName: string | undefined;
  let budgetReached = false;
  const candidate: ProfessorCandidate = {
    id: target.stableId,
    name: target.name,
    professorName: target.name,
    institution: target.institution,
    country: target.country,
    searchRegion: target.country,
    leadType: 'professor_profile',
    officialProfileUrl: target.officialProfileUrl,
    status: 'needs-evidence',
    approvedForSending: false,
    priority: 0,
    discoveryEvidence: [{
      kind: 'search-result', sourceUrl: target.officialProfileUrl, excerpt: 'Previously verified official professor profile.',
      retrievedAt: input.checkedAt, verification: 'unverified', region: target.country, query: '',
    }],
  };
  let activeFetchStatuses: number[] = [];
  let activeContentTypes: string[] = [];
  try {
    await enrichOfficialCandidate(candidate, [...hosts], {
      pageFetchBudget: input.pageFetchBudget,
      maxResearchPagesPerProfile: MAX_LINKED_RESEARCH_PAGES_PER_PROFILE,
      followSupplementaryLinks: false,
      collectContactEmail: false,
      now: () => new Date(input.checkedAt),
      onProfessorIdentity: ({ name }) => { observedName = name; },
      onProfessorTraversalDiagnostic: (value: ProfessorTraversalDiagnostics) => {
        traversal.directoryFetched = value.directoryPageFetched;
        traversal.profileLinksConsidered = value.sameHostProfileLinksConsidered;
        traversal.profileLinksSelected = value.selectedProfileLinks.length;
        traversal.profileLinksFetched = value.sameHostProfileLinksFetched;
        traversal.identityEstablished = value.professorIdentityEstablished;
        traversal.researchLinksConsidered = value.linkedResearchPagesConsidered;
        traversal.researchLinksSelected = value.linkedResearchPagesSelected.length;
        traversal.researchLinksFetched = value.linkedResearchPagesFetched;
        traversal.relevantResearchEvidenceEstablished = value.relevantOfficialResearchEvidenceEstablished;
      },
      onOfficialPageFailure: (failure) => { failures.add(failure.kind); if (failure.statusCode) statuses.add(failure.statusCode); },
      fetchPage: async (url) => {
        if (input.pageFetchBudget.remaining <= 0) { budgetReached = true; throw new Error('fetch_budget_reached'); }
        activeFetchStatuses = [];
        activeContentTypes = [];
        try {
          return await fetchOfficialPage(url, [...hosts], async (request, init) => {
            const response = await (input.fetchImpl ?? fetch)(request, init);
            if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) activeFetchStatuses.push(response.status);
            const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
            if (contentType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) activeContentTypes.push(contentType);
            return response;
          });
        } finally {
          traversal.pageFetches += 1;
          for (const status of activeFetchStatuses) statuses.add(status);
          for (const type of activeContentTypes) contentTypes.add(type);
        }
      },
    });
  } catch (error) {
    if (error instanceof DiscoveryPageFetchBudgetReached || (error instanceof Error && error.message === 'fetch_budget_reached')) budgetReached = true;
    else failures.add(safeFailureRecord(error).kind);
  }

  traversal.httpStatuses = [...statuses].slice(0, 8);
  traversal.contentTypes = [...contentTypes].slice(0, 4);
  const expectedIdentityConfirmed = Boolean(observedName && normalizeProfessorName(observedName) === normalizeProfessorName(target.name));
  const evidence = (candidate.discoveryEvidence ?? []).find((item) =>
    (item.kind === 'research' || item.kind === 'professor-profile') && Boolean(item.quote) && Boolean(item.sourceUrl),
  );
  const evidenceNamesOtherLead = Boolean(evidence?.quote && observedName && researchQuoteNamesOtherLead(evidence.quote, observedName));
  const attributableEvidence = traversal.identityEstablished && expectedIdentityConfirmed && !evidenceNamesOtherLead ? evidence : undefined;
  const quote = attributableEvidence?.quote ? sanitizeResearchEvidenceQuote(attributableEvidence.quote) : '';
  const sourceUrl = attributableEvidence?.sourceUrl;
  const matched = quote ? evaluateResearchInterestMatch(quote, input.interests) : false;
  const result = classifyResearchOutcome({
    identityEstablished: traversal.identityEstablished,
    expectedIdentityConfirmed,
    relevantResearchEvidenceEstablished: traversal.relevantResearchEvidenceEstablished && !evidenceNamesOtherLead,
    ...(quote ? { quote } : {}), matched, failedFetches: failures.size, budgetReached,
  });
  const normalizedOutcome = result.outcome === 'no_research_evidence' && failures.size
    ? { outcome: 'fetch_failed' as const, reasonCode: 'fetch_failed' as const, interestMatch: 'not_evaluated' as const,
      explanation: 'At least one selected official research page could not be inspected, so research fit remains unevaluated.' }
    : result;
  return {
    ...target,
    ...normalizedOutcome,
    ...(quote && sourceUrl ? { researchEvidence: { quote, sourceUrl: displayOfficialUrl(canonicalizeSourceUrl(sourceUrl)) } } : {}),
    failureCodes: [...failures].slice(0, 5), traversal, checkedAt: input.checkedAt,
  };
}

/** Keeps excerpts bounded and strips contact details or embedded links before local persistence. */
export function sanitizeResearchEvidenceQuote(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Validates a local report row against the already-verified professor before the owner page displays it. */
export function validatedResearchEnrichmentRow(value: unknown, target: ConfirmedProfessorResearchTarget): ConfirmedProfessorResearchResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const outcomes: ConfirmedProfessorResearchOutcome[] = ['matched', 'evidence_found_no_match', 'no_research_evidence', 'fetch_failed', 'not_evaluated'];
  const reasons: ConfirmedProfessorResearchResult['reasonCode'][] = ['interest_match', 'interest_not_matched', 'no_research_evidence', 'fetch_failed', 'fetch_budget_reached', 'identity_not_reconfirmed'];
  const matches: ConfirmedProfessorResearchResult['interestMatch'][] = ['matched', 'not_matched', 'not_evaluated'];
  const targetProfile = canonicalOfficialUrl(target.officialProfileUrl, target.country);
  const rowProfile = typeof row.officialProfileUrl === 'string' ? canonicalOfficialUrl(row.officialProfileUrl, target.country) : undefined;
  if (row.stableId !== target.stableId || row.name !== target.name || row.institution !== target.institution || row.country !== target.country ||
      !targetProfile || !rowProfile || rowProfile !== targetProfile ||
      !outcomes.includes(row.outcome as ConfirmedProfessorResearchOutcome) || !reasons.includes(row.reasonCode as ConfirmedProfessorResearchResult['reasonCode']) ||
      !matches.includes(row.interestMatch as ConfirmedProfessorResearchResult['interestMatch']) || typeof row.explanation !== 'string' || typeof row.checkedAt !== 'string') return undefined;
  const researchEvidence = row.researchEvidence && typeof row.researchEvidence === 'object' ? row.researchEvidence as Record<string, unknown> : undefined;
  let safeEvidence: ConfirmedProfessorResearchResult['researchEvidence'];
  if (researchEvidence && typeof researchEvidence.quote === 'string' && typeof researchEvidence.sourceUrl === 'string') {
    const sourceUrl = canonicalOfficialUrl(researchEvidence.sourceUrl, target.country);
    const quote = sanitizeResearchEvidenceQuote(researchEvidence.quote);
    if (sourceUrl && quote) safeEvidence = { quote, sourceUrl };
  }
  return {
    stableId: target.stableId, name: target.name, institution: target.institution, country: target.country,
    officialProfileUrl: displayOfficialUrl(targetProfile),
    outcome: row.outcome as ConfirmedProfessorResearchOutcome,
    reasonCode: row.reasonCode as ConfirmedProfessorResearchResult['reasonCode'],
    interestMatch: row.interestMatch as ConfirmedProfessorResearchResult['interestMatch'],
    explanation: row.explanation.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240),
    ...(safeEvidence ? { researchEvidence: safeEvidence } : {}),
    failureCodes: Array.isArray(row.failureCodes) ? row.failureCodes.filter((code): code is string => typeof code === 'string' && SAFE_FETCH_FAILURE_CODES.has(code)).slice(0, 5) : [],
    traversal: safeTraversalSummary(row.traversal), checkedAt: row.checkedAt.slice(0, 40),
  };
}

export function mergeResearchEnrichmentReport(
  previous: ConfirmedProfessorResearchReport | undefined,
  generatedAt: string,
  targets: ConfirmedProfessorResearchTarget[],
  updates: ConfirmedProfessorResearchResult[],
): ConfirmedProfessorResearchReport {
  const validIds = new Set(targets.map((item) => item.stableId));
  const results = new Map((previous?.professors ?? []).filter((item) => validIds.has(item.stableId)).map((item) => [item.stableId, item]));
  for (const update of updates) results.set(update.stableId, update);
  const professors = targets.flatMap((target) => {
    const result = results.get(target.stableId);
    const validated = result ? validatedResearchEnrichmentRow({ ...target, ...result }, target) : undefined;
    return validated ? [validated] : [];
  });
  return {
    schemaVersion: 1, generatedAt, totalProfessors: targets.length,
    completedProfessors: professors.filter(isResearchEnrichmentComplete).length,
    professors,
  };
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeProfessorName(value: string): string {
  return normalizeIdentity(value.replace(/^(?:(?:dr|prof|professor|associate professor|assistant professor|lecturer)\.?\s+)+/i, ''));
}

function stableId(profile: string): string {
  return `discovery-${createHash('sha256').update(profile).digest('hex').slice(0, 24)}`;
}

function canonicalOfficialUrl(value: string, country: string): string | undefined {
  try {
    const url = new URL(value);
    const hosts = (OFFICIAL_HOSTS_BY_REGION as Record<string, readonly string[]>)[country] ?? [];
    if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname.toLowerCase())) return undefined;
    return canonicalizeSourceUrl(url.toString());
  } catch { return undefined; }
}

function displayOfficialUrl(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function safeTraversalSummary(value: unknown): ProfessorResearchTraversalSummary {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const count = (key: string) => typeof row[key] === 'number' && Number.isInteger(row[key]) ? Math.min(100, Math.max(0, row[key] as number)) : 0;
  const statuses = Array.isArray(row.httpStatuses) ? row.httpStatuses.filter((status): status is number => typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599).slice(0, 8) : [];
  const contentTypes = Array.isArray(row.contentTypes) ? row.contentTypes.filter((type): type is string => typeof type === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)).slice(0, 4) : [];
  return {
    directoryFetched: row.directoryFetched === true, profileLinksConsidered: count('profileLinksConsidered'), profileLinksSelected: count('profileLinksSelected'),
    profileLinksFetched: count('profileLinksFetched'), identityEstablished: row.identityEstablished === true,
    researchLinksConsidered: count('researchLinksConsidered'), researchLinksSelected: count('researchLinksSelected'),
    researchLinksFetched: count('researchLinksFetched'), relevantResearchEvidenceEstablished: row.relevantResearchEvidenceEstablished === true,
    pageFetches: count('pageFetches'), httpStatuses: statuses, contentTypes,
  };
}
