import type { ProfessorCandidate } from '../domain/outreach-queue.ts';

export interface CountryLeadBrowserResult {
  region: string;
  professors: ProfessorCandidate[];
  general: ProfessorCandidate[];
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

  const isNamedProfile = (candidate: ProfessorCandidate) =>
    candidate.leadType === 'professor_profile'
    && Boolean(candidate.professorName?.trim())
    && Boolean(candidate.officialProfileUrl);

  return {
    region: region.trim(),
    professors: matches.filter(isNamedProfile),
    general: matches.filter((candidate) => !isNamedProfile(candidate)),
  };
}
