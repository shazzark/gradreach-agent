import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DiscoveryResultDiagnostic } from '../application/automatic-discovery.ts';

const REJECTION_REASONS = new Set([
  'exact_host', 'title', 'excerpt', 'timeout', 'dns_tls', 'rate_limited', 'http_status',
  'rejected_redirect', 'disallowed_host', 'invalid_content', 'network_error', 'mongodb_server_error', 'invalid_request', 'missing_configuration', 'not_professor_profile', 'no_named_professor_identity', 'no_official_research_evidence', 'research_interest_mismatch',
]);

export type Phase3ResultDiagnostic = {
  resultNumber?: number;
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
  stage?: 'brave_search' | 'result_validation' | 'official_page_fetch' | 'professor_evidence' | 'duplicate_check' | 'interest_match';
  country: string;
  hostname: string | null;
  outcome: 'rejected' | 'duplicate' | 'page_validated' | 'fetch_failed' | 'search_failed' | 'search_started' | 'redirect_followed';
  rejectionReasons: string[];
  targetingMode?: 'api_country' | 'query_and_host';
  resourcePath?: string;
  statusCode?: number;
  errorName?: string;
  errorCode?: string;
  causeName?: string;
  causeCode?: string;
  braveErrorCode?: string;
  braveErrorId?: string;
  requestId?: string;
  redirectDestinationHost?: string;
  redirectDestinationPath?: string;
};

export interface ProfessorTraversalDiagnostics {
  directoryPageFetched: boolean;
  sameHostProfileLinksFound: number;
  sameHostProfileLinksConsidered: number;
  sameHostProfileLinksFetched: number;
  selectedProfileLinks: Array<{
    rank: number;
    reasons: Array<'named_link_text' | 'named_faculty_context' | 'profile_url_pattern' | 'faculty_card_context' | 'profile_label' | 'academic_role'>;
  }>;
  profileLinkRejections?: Array<{ reason: 'excluded_navigation_or_nonacademic' | 'insufficient_profile_signals'; count: number }>;
  professorIdentityEstablished: boolean;
  linkedResearchPagesConsidered: number;
  linkedResearchPagesFound: number;
  linkedResearchPagesSelected: Array<{
    rank: number;
    reasons: Array<'research_anchor_text' | 'research_url_pattern' | 'research_section_context'>;
  }>;
  linkedResearchPagesFetched: number;
  researchPageLinkRejections?: Array<{ reason: 'non_research_destination' | 'no_research_signal'; count: number }>;
  relevantOfficialResearchEvidenceEstablished: boolean;
}

const RESULT_STAGES = new Set<DiscoveryResultDiagnostic['stage']>([
  'result_validation', 'professor_evidence', 'official_page_fetch', 'duplicate_check', 'interest_match',
]);

/** Keeps only bounded, controlled fields suitable for a durable discovery run record. */
export function storedDiscoveryResultDiagnostic(
  diagnostic: Phase3ResultDiagnostic,
  resultNumber: number,
): DiscoveryResultDiagnostic | undefined {
  if (!Number.isInteger(resultNumber) || resultNumber < 1 || resultNumber > 3) return undefined;
  const reason = diagnostic.outcome === 'duplicate'
    ? 'duplicate'
    : diagnostic.outcome === 'page_validated'
      ? 'passed_evidence_gates'
      : diagnostic.rejectionReasons.find((value) => REJECTION_REASONS.has(value));
  if (!reason) return undefined;

  const inferredStage: DiscoveryResultDiagnostic['stage'] = reason === 'duplicate'
    ? 'duplicate_check'
    : reason === 'research_interest_mismatch'
      ? 'interest_match'
      : reason === 'no_named_professor_identity' || reason === 'no_official_research_evidence'
        ? 'professor_evidence'
        : diagnostic.outcome === 'fetch_failed'
          ? 'official_page_fetch'
          : 'result_validation';
  const stage = diagnostic.stage && RESULT_STAGES.has(diagnostic.stage as DiscoveryResultDiagnostic['stage'])
    ? diagnostic.stage as DiscoveryResultDiagnostic['stage']
    : inferredStage;
  const statusCode = diagnostic.outcome === 'fetch_failed' && Number.isInteger(diagnostic.statusCode) &&
    diagnostic.statusCode! >= 100 && diagnostic.statusCode! <= 599 ? diagnostic.statusCode : undefined;
  const networkCode = diagnostic.outcome === 'fetch_failed'
    ? sanitizeTransportCode(diagnostic.errorCode) ?? sanitizeTransportCode(diagnostic.causeCode)
    : undefined;
  if (reason === 'exact_host') {
    const observedHostname = sanitizeHostname(diagnostic.hostname ?? undefined);
    return {
      resultNumber,
      stage,
      reason,
      ...(observedHostname ? { observedHostname } : {}),
    };
  }
  const safeCount = (value: number | undefined, maximum: number) => Number.isInteger(value) && value! >= 0 && value! <= maximum ? value : undefined;
  const sameHostProfileLinksFound = safeCount(diagnostic.sameHostProfileLinksFound, 100);
  const sameHostProfileLinksConsidered = safeCount(diagnostic.sameHostProfileLinksConsidered, 100);
  const sameHostProfileLinksFetched = safeCount(diagnostic.sameHostProfileLinksFetched, 10);
  const linkedResearchPagesConsidered = safeCount(diagnostic.linkedResearchPagesConsidered, 100);
  const linkedResearchPagesFound = safeCount(diagnostic.linkedResearchPagesFound, 100);
  const linkedResearchPagesFetched = safeCount(diagnostic.linkedResearchPagesFetched, 5);
  const selectedResearchReasonCodes = new Set(['research_anchor_text', 'research_url_pattern', 'research_section_context']);
  const linkedResearchPagesSelected = Array.isArray(diagnostic.linkedResearchPagesSelected)
    ? diagnostic.linkedResearchPagesSelected.slice(0, 5).flatMap((selection) => {
      if (!Number.isInteger(selection.rank) || selection.rank < 1 || selection.rank > 5 || !Array.isArray(selection.reasons)) return [];
      const reasons = [...new Set(selection.reasons.filter((reason) => selectedResearchReasonCodes.has(reason)))];
      return reasons.length ? [{ rank: selection.rank, reasons }] : [];
    })
    : undefined;
  const researchPageLinkRejections = Array.isArray(diagnostic.researchPageLinkRejections)
    ? diagnostic.researchPageLinkRejections.slice(0, 2).flatMap(({ reason, count }) =>
      (reason === 'non_research_destination' || reason === 'no_research_signal') &&
      Number.isInteger(count) && count > 0 && count <= 100 ? [{ reason, count }] : [])
    : undefined;
  const hasResearchConsideredCount = linkedResearchPagesConsidered !== undefined;
  const selectedResearchCount = linkedResearchPagesSelected?.length ?? 0;
  const rejectedResearchCount = researchPageLinkRejections?.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const researchCountsConsistent = !hasResearchConsideredCount || (
    linkedResearchPagesFound !== undefined && linkedResearchPagesFetched !== undefined &&
    linkedResearchPagesFound <= linkedResearchPagesConsidered! &&
    selectedResearchCount <= linkedResearchPagesFound && linkedResearchPagesFetched <= selectedResearchCount &&
    rejectedResearchCount === linkedResearchPagesConsidered! - linkedResearchPagesFound
  );
  const selectionReasonCodes = new Set(['named_link_text', 'named_faculty_context', 'profile_url_pattern', 'faculty_card_context', 'profile_label', 'academic_role']);
  const selectedProfileLinks = Array.isArray(diagnostic.selectedProfileLinks)
    ? diagnostic.selectedProfileLinks.slice(0, 12).flatMap((selection) => {
      if (!Number.isInteger(selection.rank) || selection.rank < 1 || selection.rank > 10 || !Array.isArray(selection.reasons)) return [];
      const reasons = [...new Set(selection.reasons.filter((reason) => selectionReasonCodes.has(reason)).slice(0, 5))];
      return reasons.length ? [{ rank: selection.rank, reasons }] : [];
    })
    : undefined;
  const profileLinkRejections = Array.isArray(diagnostic.profileLinkRejections)
    ? diagnostic.profileLinkRejections.slice(0, 2).flatMap(({ reason, count }) =>
      (reason === 'excluded_navigation_or_nonacademic' || reason === 'insufficient_profile_signals') &&
      Number.isInteger(count) && count > 0 && count <= 100 ? [{ reason, count }] : [])
    : undefined;
  const hasProfileConsideredCount = sameHostProfileLinksConsidered !== undefined;
  const selectedProfileCount = selectedProfileLinks?.length ?? 0;
  const rejectedProfileCount = profileLinkRejections?.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const profileCountsConsistent = !hasProfileConsideredCount || (
    sameHostProfileLinksFound !== undefined && sameHostProfileLinksFetched !== undefined &&
    sameHostProfileLinksFound <= sameHostProfileLinksConsidered! &&
    selectedProfileCount <= sameHostProfileLinksFound && sameHostProfileLinksFetched <= selectedProfileCount &&
    rejectedProfileCount === sameHostProfileLinksConsidered! - sameHostProfileLinksFound
  );
  return {
    resultNumber,
    stage,
    reason,
    ...(typeof diagnostic.directoryPageFetched === 'boolean' ? { directoryPageFetched: diagnostic.directoryPageFetched } : {}),
    ...(profileCountsConsistent && sameHostProfileLinksFound !== undefined ? { sameHostProfileLinksFound } : {}),
    ...(profileCountsConsistent && sameHostProfileLinksConsidered !== undefined ? { sameHostProfileLinksConsidered } : {}),
    ...(profileCountsConsistent && sameHostProfileLinksFetched !== undefined ? { sameHostProfileLinksFetched } : {}),
    ...(profileCountsConsistent && selectedProfileLinks?.length ? { selectedProfileLinks } : {}),
    ...(profileCountsConsistent && profileLinkRejections?.length ? { profileLinkRejections } : {}),
    ...(!hasProfileConsideredCount && sameHostProfileLinksFound !== undefined ? { sameHostProfileLinksFound } : {}),
    ...(!hasProfileConsideredCount && sameHostProfileLinksConsidered !== undefined ? { sameHostProfileLinksConsidered } : {}),
    ...(!hasProfileConsideredCount && sameHostProfileLinksFetched !== undefined ? { sameHostProfileLinksFetched } : {}),
    ...(typeof diagnostic.professorIdentityEstablished === 'boolean' ? { professorIdentityEstablished: diagnostic.professorIdentityEstablished } : {}),
    ...(researchCountsConsistent && linkedResearchPagesConsidered !== undefined ? { linkedResearchPagesConsidered } : {}),
    ...(researchCountsConsistent && linkedResearchPagesFound !== undefined ? { linkedResearchPagesFound } : {}),
    ...(researchCountsConsistent && linkedResearchPagesSelected?.length ? { linkedResearchPagesSelected } : {}),
    ...(researchCountsConsistent && linkedResearchPagesFetched !== undefined ? { linkedResearchPagesFetched } : {}),
    ...(researchCountsConsistent && researchPageLinkRejections?.length ? { researchPageLinkRejections } : {}),
    ...(!hasResearchConsideredCount && linkedResearchPagesFound !== undefined ? { linkedResearchPagesFound } : {}),
    ...(!hasResearchConsideredCount && linkedResearchPagesFetched !== undefined ? { linkedResearchPagesFetched } : {}),
    ...(typeof diagnostic.relevantOfficialResearchEvidenceEstablished === 'boolean'
      ? { relevantOfficialResearchEvidenceEstablished: diagnostic.relevantOfficialResearchEvidenceEstablished } : {}),
    ...(statusCode ? { statusCode } : {}),
    ...(networkCode ? { networkCode } : {}),
  };
}

/** Appends one content-free result record so later failures cannot replace earlier diagnostics. */
export async function appendPhase3ResultDiagnostic(
  diagnostic: Phase3ResultDiagnostic,
  path = 'outputs/phase3-result-diagnostics.jsonl',
): Promise<void> {
  const country = diagnostic.country.trim();
  const hostname = diagnostic.hostname?.toLowerCase() ?? null;
  const resourcePath = sanitizePath(diagnostic.resourcePath);
  const statusCode = Number.isInteger(diagnostic.statusCode) && diagnostic.statusCode! >= 100 && diagnostic.statusCode! <= 599
    ? diagnostic.statusCode
    : undefined;
  const errorName = sanitizeErrorName(diagnostic.errorName);
  const errorCode = sanitizeTransportCode(diagnostic.errorCode);
  const causeName = sanitizeErrorName(diagnostic.causeName);
  const causeCode = sanitizeTransportCode(diagnostic.causeCode);
  const braveErrorCode = sanitizeIdentifier(diagnostic.braveErrorCode);
  const braveErrorId = sanitizeIdentifier(diagnostic.braveErrorId);
  const requestId = sanitizeIdentifier(diagnostic.requestId);
  const redirectDestinationHost = sanitizeHostname(diagnostic.redirectDestinationHost);
  const redirectDestinationPath = sanitizePath(diagnostic.redirectDestinationPath);
  if (!country || country.length > 80 || /[\u0000-\u001f\u007f]/.test(country)) {
    throw new TypeError('Invalid diagnostic country');
  }
  if (hostname !== null && !isHostname(hostname)) throw new TypeError('Invalid diagnostic hostname');
  if ((diagnostic.stage !== undefined && !['brave_search', 'result_validation', 'official_page_fetch', 'professor_evidence', 'duplicate_check', 'interest_match'].includes(diagnostic.stage)) ||
      !['rejected', 'duplicate', 'page_validated', 'fetch_failed', 'search_failed', 'search_started', 'redirect_followed'].includes(diagnostic.outcome) ||
      (diagnostic.outcome === 'search_failed' && diagnostic.stage !== 'brave_search') ||
      (diagnostic.targetingMode !== undefined && !['api_country', 'query_and_host'].includes(diagnostic.targetingMode)) ||
      (diagnostic.outcome === 'search_started' && (diagnostic.stage !== 'brave_search' || !['api_country', 'query_and_host'].includes(diagnostic.targetingMode ?? ''))) ||
      diagnostic.rejectionReasons.some((reason) => !REJECTION_REASONS.has(reason))) {
    throw new TypeError('Invalid result diagnostic');
  }

  const record = {
    checkedAt: new Date().toISOString(),
    ...(Number.isInteger(diagnostic.resultNumber) && diagnostic.resultNumber! >= 1 && diagnostic.resultNumber! <= 3
      ? { resultNumber: diagnostic.resultNumber } : {}),
    ...(diagnostic.stage ? { stage: diagnostic.stage } : {}),
    country,
    hostname,
    outcome: diagnostic.outcome,
    rejectionReasons: [...new Set(diagnostic.rejectionReasons)],
    ...(diagnostic.targetingMode ? { targetingMode: diagnostic.targetingMode } : {}),
    ...(resourcePath ? { resourcePath } : {}),
    ...(statusCode ? { statusCode } : {}),
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(causeName ? { causeName } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(braveErrorCode ? { braveErrorCode } : {}),
    ...(braveErrorId ? { braveErrorId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(redirectDestinationHost && redirectDestinationPath ? { redirectDestinationHost, redirectDestinationPath } : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function sanitizePath(value: string | undefined): string | undefined {
  const pathOnly = value?.split(/[?#]/, 1)[0];
  return pathOnly && pathOnly.length <= 256 && pathOnly.startsWith('/') &&
    /^\/[A-Za-z0-9._~/-]*$/.test(pathOnly) && !pathOnly.split('/').includes('..')
    ? pathOnly
    : undefined;
}

function sanitizeErrorName(value: string | undefined): string | undefined {
  const allowed = new Set([
    'AbortError', 'ConnectTimeoutError', 'Error', 'FetchError', 'HeadersTimeoutError', 'MongoNetworkError',
    'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoTimeoutError', 'RequestAbortedError',
    'SocketError', 'TimeoutError', 'TypeError',
  ]);
  return value && allowed.has(value) ? value : undefined;
}

function sanitizeTransportCode(value: string | undefined): string | undefined {
  const allowed = new Set([
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED',
    'ECONNRESET', 'EHOSTUNREACH', 'EPIPE', 'ESOCKETTIMEDOUT', 'ETIMEOUT', 'ETIMEDOUT',
    'ENETUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  ]);
  const normalized = value?.toUpperCase();
  return normalized && allowed.has(normalized) ? normalized : undefined;
}

function sanitizeIdentifier(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split('.').length >= 2 && value.split('.').every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function sanitizeHostname(value: string | undefined): string | undefined {
  const hostname = value?.toLowerCase();
  return hostname && isHostname(hostname) ? hostname : undefined;
}
