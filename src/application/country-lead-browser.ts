import type { ProfessorCandidate } from '../domain/outreach-queue.ts';

export interface CountryLeadBrowserResult {
  region: string;
  professors: ProfessorCandidate[];
  general: ProfessorCandidate[];
}

function isSupportedProfessorProfile(candidate: ProfessorCandidate): boolean {
  const professorName = candidate.professorName?.trim();
  const profile = candidate.discoveryEvidence?.find((item) =>
    item.kind === 'professor-profile' && item.sourceUrl === candidate.officialProfileUrl,
  );
  if (candidate.leadType !== 'professor_profile' || !professorName || !candidate.officialProfileUrl || !profile?.quote?.trim()) return false;
  const namePattern = new RegExp(professorName.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
  return profile.quote.trim().length >= 50 && profile.excerpt.includes(profile.quote) && namePattern.test(profile.excerpt);
}

/** Filters by discovery search scope, never by inferred professor nationality or affiliation. */
export function browseLeadsByDiscoveryRegion(
  candidates: ProfessorCandidate[],
  region: string,
): CountryLeadBrowserResult {
  const normalizedRegion = region.trim().toLocaleLowerCase();
  if (!normalizedRegion) return { region: region.trim(), professors: [], general: [] };

  const matches = candidates.filter((candidate) => {
    const savedSearchRegion = candidate.searchRegion?.trim();
    const evidenceRegions = savedSearchRegion
      ? [savedSearchRegion]
      : (candidate.discoveryEvidence ?? []).map((evidence) => evidence.region.trim()).filter(Boolean);
    return evidenceRegions.some((candidateRegion) => candidateRegion.toLocaleLowerCase() === normalizedRegion);
  });

  return {
    region: region.trim(),
    professors: matches.filter(isSupportedProfessorProfile),
    general: matches.filter((candidate) => !isSupportedProfessorProfile(candidate)),
  };
}
