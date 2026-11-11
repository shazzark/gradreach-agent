import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { matchingResearchInterests, researchQuoteNamesOtherLead } from './professor-research-evidence.ts';

const CANADA_HOSTS: string[] = [...OFFICIAL_HOSTS_BY_REGION.Canada];

export interface SavedPreviewEvidenceRecord {
  recordId: string;
  identity: { established: boolean; sourceUrl: string; supportingExcerpt: string };
  research: { extractedSourceUrl?: string; supportingExcerpt?: string };
}

export interface ReplayedPreviewEvidenceOutcome {
  recordId: string;
  identityEstablished: boolean;
  researchSourceUrl?: string;
  supportingExcerpt?: string;
  researchGate: 'matched' | 'not_matched' | 'other_named_lead' | 'no_research_quote' | 'identity_not_established' | 'official_source_unverified';
  matchedInterestCount: number;
  outcome: 'research_gate_passed_remaining_checks_not_replayed' | 'stopped';
  reasonCode: string;
}

function safeOfficialSource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !CANADA_HOSTS.includes(url.hostname.toLowerCase())) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

function nameFromIdentityExcerpt(value: string): string {
  return value.split(/\s+[—–-]\s+/u, 1)[0]?.replace(/^(?:Dr\.?|Prof\.?|Professor)\s+/i, '').trim() ?? '';
}

/** Rechecks only saved report evidence; duplicate and human-review state are intentionally outside this offline result. */
export function reevaluateSavedPreviewEvidence(
  record: SavedPreviewEvidenceRecord,
  researchInterests: string[],
): ReplayedPreviewEvidenceOutcome {
  const profileSource = safeOfficialSource(record.identity.sourceUrl);
  const researchSource = safeOfficialSource(record.research.extractedSourceUrl);
  const supportingExcerpt = record.research.supportingExcerpt;
  const base = { recordId: record.recordId, identityEstablished: record.identity.established };
  if (!record.identity.established) return {
    ...base, researchGate: 'identity_not_established', matchedInterestCount: 0, outcome: 'stopped', reasonCode: 'identity_not_established',
  };
  if (!profileSource) return {
    ...base, researchGate: 'official_source_unverified', matchedInterestCount: 0, outcome: 'stopped', reasonCode: 'official_source_unverified',
  };
  if (!supportingExcerpt || !researchSource) return {
    ...base, researchGate: 'no_research_quote', matchedInterestCount: 0, outcome: 'stopped', reasonCode: 'no_research_quote',
  };
  const professorName = nameFromIdentityExcerpt(record.identity.supportingExcerpt);
  if (researchQuoteNamesOtherLead(supportingExcerpt, professorName)) return {
    ...base, researchSourceUrl: researchSource, supportingExcerpt, researchGate: 'other_named_lead',
    matchedInterestCount: 0, outcome: 'stopped', reasonCode: 'research_attributed_to_other_lead',
  };
  const matched = matchingResearchInterests(supportingExcerpt, researchInterests);
  return {
    ...base, researchSourceUrl: researchSource, supportingExcerpt,
    researchGate: matched.length ? 'matched' : 'not_matched', matchedInterestCount: matched.length,
    outcome: matched.length ? 'research_gate_passed_remaining_checks_not_replayed' : 'stopped',
    reasonCode: matched.length ? 'remaining_duplicate_and_review_gates_not_replayed' : 'research_interest_not_matched',
  };
}
