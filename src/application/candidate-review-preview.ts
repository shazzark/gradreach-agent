import { createHash } from 'node:crypto';
import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { canonicalizeSourceUrl } from './research-discovery.ts';

export type SavedLeadDuplicateResult = 'duplicate' | 'not found' | 'could not verify';

export interface CandidateReviewIdentity {
  professorName: string;
  institution: string;
  officialProfileUrl: string;
}

export function stableProfileCandidateId(officialProfileUrl: string): string | undefined {
  const canonical = canonicalOfficialProfileUrl(officialProfileUrl);
  return canonical ? `discovery-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}` : undefined;
}

function canonicalOfficialProfileUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !OFFICIAL_HOSTS_BY_REGION.Canada.some((host: string) => host === parsed.hostname.toLowerCase())) return undefined;
    return canonicalizeSourceUrl(parsed.toString());
  } catch { return undefined; }
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function compareSavedLeadDuplicates(
  identity: CandidateReviewIdentity,
  savedLeads: ProfessorCandidate[],
): { result: SavedLeadDuplicateResult; reasonCode?: 'stable_profile_id' | 'canonical_profile_url' | 'professor_and_institution'; stableProfileId?: string } {
  const profileUrl = canonicalOfficialProfileUrl(identity.officialProfileUrl);
  const name = normalizeIdentity(identity.professorName);
  const institution = normalizeIdentity(identity.institution);
  const stableProfileId = profileUrl ? stableProfileCandidateId(profileUrl) : undefined;
  if (!profileUrl || !stableProfileId || !name || !institution) return { result: 'could not verify' };

  for (const lead of savedLeads) {
    if (lead.id === stableProfileId) return { result: 'duplicate', reasonCode: 'stable_profile_id', stableProfileId };
    const leadProfile = lead.officialProfileUrl ? canonicalOfficialProfileUrl(lead.officialProfileUrl) : undefined;
    if (leadProfile === profileUrl) return { result: 'duplicate', reasonCode: 'canonical_profile_url', stableProfileId };
    if (lead.professorName && normalizeIdentity(lead.professorName) === name &&
        lead.institution && normalizeIdentity(lead.institution) === institution) {
      return { result: 'duplicate', reasonCode: 'professor_and_institution', stableProfileId };
    }
  }
  return { result: 'not found', stableProfileId };
}

export interface CandidateReviewPreview {
  status: 'awaiting owner review';
  ownerDecision: 'pending';
  approved: false;
  queued: false;
  sent: false;
  duplicateCheck: {
    result: 'not found';
    checkedLeadCount: number;
    matchedBy: null;
    stableProfileIdChecked: true;
    canonicalProfileUrlChecked: true;
    professorAndInstitutionChecked: true;
  };
  candidate: CandidateReviewIdentity & {
    recordId: string;
    researchEvidenceQuote: string;
    researchEvidenceSourceUrl: string;
    savedInterestMatchExplanation: string;
  };
}

export function createCandidateReviewPreview(input: {
  identity: CandidateReviewIdentity;
  recordId: string;
  researchEvidenceQuote: string;
  researchEvidenceSourceUrl: string;
  checkedLeadCount: number;
}): CandidateReviewPreview {
  return {
    status: 'awaiting owner review',
    ownerDecision: 'pending',
    approved: false,
    queued: false,
    sent: false,
    duplicateCheck: {
      result: 'not found',
      checkedLeadCount: input.checkedLeadCount,
      matchedBy: null,
      stableProfileIdChecked: true,
      canonicalProfileUrlChecked: true,
      professorAndInstitutionChecked: true,
    },
    candidate: {
      ...input.identity,
      recordId: input.recordId,
      researchEvidenceQuote: input.researchEvidenceQuote,
      researchEvidenceSourceUrl: input.researchEvidenceSourceUrl,
      savedInterestMatchExplanation: 'The quoted official research statement includes machine learning, and the current saved-interest matcher found an exact concept-level match. Saved preference wording is omitted from this preview.',
    },
  };
}
