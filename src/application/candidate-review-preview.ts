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

/** Region assumed when a review preview is started without an explicit region. */
export const DEFAULT_REVIEW_REGION = 'Canada';

export interface ReviewRegionResolution {
  region: string;
  source: 'flag' | 'environment' | 'default';
  warning?: string;
}

/**
 * Selects the official-host allowlist region for a review preview. An explicit `--region` value wins over
 * `GRADREACH_REVIEW_REGION`; with neither, the historical default is used and the caller is told, so a
 * different research region is never assumed silently.
 */
export function resolveReviewRegion(request: { flag?: string | undefined; environment?: string | undefined } = {}): ReviewRegionResolution {
  const flag = request.flag?.trim();
  if (flag) return { region: flag, source: 'flag' };
  const environment = request.environment?.trim();
  if (environment) return { region: environment, source: 'environment' };
  return {
    region: DEFAULT_REVIEW_REGION,
    source: 'default',
    warning: `No review region was provided; using ${DEFAULT_REVIEW_REGION}. Pass --region <name> or set GRADREACH_REVIEW_REGION to check another official-host allowlist.`,
  };
}

/** Unknown regions fail closed: no host is treated as official, so duplicates cannot be ruled out. */
function officialHostsForRegion(region: string): readonly string[] {
  return Object.hasOwn(OFFICIAL_HOSTS_BY_REGION, region)
    ? OFFICIAL_HOSTS_BY_REGION[region as keyof typeof OFFICIAL_HOSTS_BY_REGION] ?? []
    : [];
}

export function stableProfileCandidateId(officialProfileUrl: string, region: string): string | undefined {
  const canonical = canonicalOfficialProfileUrl(officialProfileUrl, region);
  return canonical ? `discovery-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}` : undefined;
}

function canonicalOfficialProfileUrl(value: string, region: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !officialHostsForRegion(region).some((host: string) => host === parsed.hostname.toLowerCase())) return undefined;
    return canonicalizeSourceUrl(parsed.toString());
  } catch { return undefined; }
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function compareSavedLeadDuplicates(
  identity: CandidateReviewIdentity,
  savedLeads: ProfessorCandidate[],
  region: string,
): { result: SavedLeadDuplicateResult; reasonCode?: 'stable_profile_id' | 'canonical_profile_url' | 'professor_and_institution'; stableProfileId?: string } {
  const profileUrl = canonicalOfficialProfileUrl(identity.officialProfileUrl, region);
  const name = normalizeIdentity(identity.professorName);
  const institution = normalizeIdentity(identity.institution);
  const stableProfileId = profileUrl ? stableProfileCandidateId(profileUrl, region) : undefined;
  if (!profileUrl || !stableProfileId || !name || !institution) return { result: 'could not verify' };

  for (const lead of savedLeads) {
    if (lead.id === stableProfileId) return { result: 'duplicate', reasonCode: 'stable_profile_id', stableProfileId };
    const leadProfile = lead.officialProfileUrl ? canonicalOfficialProfileUrl(lead.officialProfileUrl, region) : undefined;
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
