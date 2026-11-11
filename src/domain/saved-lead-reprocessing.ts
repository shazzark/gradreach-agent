export const MAX_SAVED_LEADS_PER_REPROCESS_RUN = 25;

export type SavedLeadReprocessReason =
  | 'evidence_added'
  | 'protected_state'
  | 'missing_source'
  | 'official_host_rejected'
  | 'duplicate_profile'
  | 'duplicate_identifier'
  | 'run_fetch_limit'
  | 'identity_not_established'
  | 'identity_mismatch'
  | 'research_evidence_missing'
  | 'interest_mismatch'
  | 'no_new_evidence'
  | 'record_changed'
  | 'invalid_content'
  | 'http_status'
  | 'rate_limited'
  | 'network_error'
  | 'disallowed_host'
  | 'rejected_redirect'
  | 'timeout'
  | 'dns_tls'
  | 'fetch_failed';

export type SavedLeadContentErrorCode =
  | 'unsupported_content_type'
  | 'empty_content'
  | 'unsupported_document'
  | 'invalid_content';

export type SavedLeadReprocessStageOutcome =
  | 'eligibility_gate'
  | 'official_page_fetch'
  | 'identity_check'
  | 'research_check'
  | 'interest_check'
  | 'duplicate_check'
  | 'persistence_check'
  | 'fetch_limit'
  | 'enriched';

export interface SavedLeadTraversalDiagnostics {
  directoryFetched: boolean;
  profileLinksConsidered: number;
  profileLinksSelected: number;
  profileLinksFetched: number;
  identityEstablished: boolean;
  researchLinksConsidered: number;
  researchLinksEligible: number;
  researchLinksSelected: number;
  researchLinksFetched: number;
  relevantResearchEstablished: boolean;
}

export interface SavedLeadReprocessDiagnostics {
  stageOutcome: SavedLeadReprocessStageOutcome;
  traversal: SavedLeadTraversalDiagnostics;
  failedStage?: 'official_page_fetch' | 'profile_page_fetch' | 'research_page_fetch';
  httpStatus?: number;
  contentErrorCode?: SavedLeadContentErrorCode;
}

export interface SavedLeadReprocessResult {
  candidateId: string;
  outcome: 'enriched' | 'unchanged' | 'failed';
  reasonCode: SavedLeadReprocessReason;
  diagnostics: SavedLeadReprocessDiagnostics;
}

export interface SavedLeadReprocessCounts {
  inspected: number;
  enriched: number;
  unchanged: number;
  failed: number;
  pageFetches: number;
}

export interface SavedLeadReprocessReport {
  counts: SavedLeadReprocessCounts;
  reasonCounts: Partial<Record<SavedLeadReprocessReason, number>>;
  omittedByLeadLimit: number;
  duplicateIdentifiersSkipped: number;
}

export interface SavedLeadReprocessRun {
  id: string;
  state: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  counts: SavedLeadReprocessCounts;
  reasonCounts: Partial<Record<SavedLeadReprocessReason, number>>;
  omittedByLeadLimit: number;
  duplicateIdentifiersSkipped: number;
  results: SavedLeadReprocessResult[];
  failureReason?: string;
}
