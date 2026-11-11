import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import type { ProfessorResearchEvidencePackage } from '../domain/professor-research-evidence.ts';
import { OFFICIAL_HOSTS_BY_REGION, OFFICIAL_INSTITUTION_BY_REGION } from '../config/official-host-allowlist.ts';
import { extractOfficialPageExcerpt, extractProfessorProfileEvidence } from './research-discovery.ts';
import { matchingResearchInterests } from '../domain/research-interest-match.ts';

export { matchingResearchInterests } from '../domain/research-interest-match.ts';

export type { ProfessorResearchEvidencePackage } from '../domain/professor-research-evidence.ts';

export async function persistPreparedProfessorEvidence(input: {
  candidates: ProfessorCandidate[];
  researchInterests: string[];
  checkedAt: string;
  runId: string;
  repository: { save(check: { id: string; candidateId: string; sourceUrl: string; checkedAt: string; runId: string; outcome: 'checked'; excerpt: string; evidencePackage: ProfessorResearchEvidencePackage }): Promise<void> };
}) {
  const saved: ProfessorResearchEvidencePackage[] = [];
  for (const candidate of input.candidates) {
    if (!['needs-evidence', 'ready-for-review'].includes(candidate.status) || candidate.discoveryReview || candidate.approvedForSending || candidate.leadType !== 'professor_profile') continue;
    const evidencePackage = prepareSavedProfessorEvidence({ candidate, researchInterests: input.researchInterests, checkedAt: input.checkedAt });
    const excerpt = candidate.discoveryEvidence?.find((item) => item.kind === 'professor-profile' && item.sourceUrl === evidencePackage.sourceUrl)?.excerpt.slice(0, 2000) ?? '';
    await input.repository.save({
      id: `${input.runId}:${candidate.id}`, candidateId: candidate.id, sourceUrl: evidencePackage.sourceUrl,
      checkedAt: input.checkedAt, runId: input.runId, outcome: 'checked', excerpt, evidencePackage,
    });
    saved.push(evidencePackage);
  }
  return saved;
}

/** Rejects a project quote when it explicitly names a different investigator as its lead. */
export function researchQuoteNamesOtherLead(quote: string, professorName: string): boolean {
  const match = quote.match(/\b(?:led|headed|directed)\s+by\s+(?:Dr\.?|Prof\.?|Professor)\s+([\p{Lu}][\p{L}.'’\-]+(?:\s+[\p{Lu}][\p{L}.'’\-]+){1,2})/iu);
  return Boolean(match?.[1] && normalizeName(match[1]) !== normalizeName(professorName));
}

export function prepareFetchedProfessorEvidence(input: {
  candidate: ProfessorCandidate;
  sourceUrl: string;
  html: string;
  researchInterests: string[];
  checkedAt: string;
}): ProfessorResearchEvidencePackage {
  const pageText = extractOfficialPageExcerpt(input.html);
  const extracted = extractProfessorProfileEvidence(input.html);
  const identityMatchesSavedLead = !input.candidate.professorName || !extracted ||
    normalizeName(input.candidate.professorName) === normalizeName(extracted.name);
  return createPackage({
    candidate: input.candidate,
    sourceUrl: input.sourceUrl,
    checkedAt: input.checkedAt,
    pageText,
    researchPageText: pageText,
    researchSourceUrl: input.sourceUrl,
    identitySourceUrl: input.sourceUrl,
    researchInterests: input.researchInterests,
    ...(extracted ? { professorName: extracted.name, identityQuote: extracted.identityQuote, researchQuote: extracted.quote } : {}),
    identityMatchesSavedLead,
  });
}

export function prepareSavedProfessorEvidence(input: {
  candidate: ProfessorCandidate;
  researchInterests: string[];
  checkedAt: string;
}): ProfessorResearchEvidencePackage {
  const sourceUrl = input.candidate.officialProfileUrl ?? '';
  const profileEvidence = input.candidate.discoveryEvidence?.find((item) =>
    item.kind === 'professor-profile' && item.sourceUrl === sourceUrl,
  );
  const researchEvidence = input.candidate.discoveryEvidence?.find((item) => item.kind === 'research' && Boolean(item.quote?.trim())) ??
    input.candidate.discoveryEvidence?.find((item) => item.kind === 'professor-profile' && Boolean(item.quote?.trim()));
  const professorName = input.candidate.professorName?.trim();
  const identityExcerpt = profileEvidence?.excerpt ?? '';
  const researchExcerpt = researchEvidence?.excerpt ?? '';
  const researchQuote = researchEvidence?.quote?.trim();
  const identityMatchesSavedLead = Boolean(professorName && containsName(identityExcerpt, professorName));
  const quoteIsExact = Boolean(researchQuote && researchQuote.length <= 600 && researchExcerpt.includes(researchQuote));
  return createPackage({
    candidate: input.candidate,
    sourceUrl,
    identitySourceUrl: sourceUrl,
    researchSourceUrl: researchEvidence?.sourceUrl ?? '',
    checkedAt: input.checkedAt,
    pageText: identityExcerpt,
    researchPageText: researchExcerpt,
    researchInterests: input.researchInterests,
    ...(professorName ? { professorName, identityQuote: professorName } : {}),
    ...(quoteIsExact && researchQuote ? { researchQuote } : {}),
    identityMatchesSavedLead,
  });
}

function createPackage(input: {
  candidate: ProfessorCandidate;
  sourceUrl: string;
  identitySourceUrl: string;
  researchSourceUrl: string;
  checkedAt: string;
  pageText: string;
  researchPageText: string;
  researchInterests: string[];
  professorName?: string;
  identityQuote?: string;
  researchQuote?: string;
  identityMatchesSavedLead: boolean;
}): ProfessorResearchEvidencePackage {
  const region = input.candidate.searchRegion || input.candidate.country;
  const hosts = OFFICIAL_HOSTS_BY_REGION[region as keyof typeof OFFICIAL_HOSTS_BY_REGION] ?? [];
  const exactOfficialSource = isExactOfficialSource(input.identitySourceUrl, hosts);
  const exactResearchSource = isExactOfficialSource(input.researchSourceUrl, hosts);
  const institution = OFFICIAL_INSTITUTION_BY_REGION[region as keyof typeof OFFICIAL_INSTITUTION_BY_REGION];
  const affiliationVerified = exactOfficialSource && Boolean(institution);
  const otherNamedLead = Boolean(input.researchQuote && input.professorName && researchQuoteNamesOtherLead(input.researchQuote, input.professorName));
  const quoteIsExact = Boolean(input.researchQuote && input.researchPageText.includes(input.researchQuote) && exactResearchSource && !otherNamedLead);
  const namedProfessor = Boolean(input.professorName && input.identityQuote &&
    containsName(input.pageText, input.professorName) && input.identityMatchesSavedLead);
  const interests = quoteIsExact ? matchingResearchInterests(input.researchQuote!, input.researchInterests) : [];
  const uncertaintyReasons: string[] = [];
  if (!exactOfficialSource) uncertaintyReasons.push('The source is not on an exact allowlisted HTTPS host.');
  if (!namedProfessor) uncertaintyReasons.push('The page does not establish the saved professor identity.');
  if (otherNamedLead) uncertaintyReasons.push('The research project names a different lead investigator.');
  else if (!quoteIsExact) uncertaintyReasons.push('No substantive research quote was verified on an exact allowlisted official university page.');
  if (!affiliationVerified) uncertaintyReasons.push('The official host could not verify a university affiliation for this region.');
  if (!input.researchInterests.length) uncertaintyReasons.push('No saved research interests are available for comparison.');

  const complete = uncertaintyReasons.length === 0;
  const recommendation = !complete ? 'uncertain' : interests.length ? 'likely relevant' : 'unlikely';
  const rationale = !complete
    ? uncertaintyReasons[0]!
    : interests.length
      ? `The official profile identifies ${input.professorName}, confirms ${institution}, and official research evidence matches ${interests.length} saved interest${interests.length === 1 ? '' : 's'}.`
      : `The official profile identifies ${input.professorName} at ${institution}, but its research quote did not match the saved interests.`;
  return {
    sourceUrl: input.sourceUrl,
    identitySourceUrl: input.identitySourceUrl,
    ...(exactResearchSource ? { researchSourceUrl: input.researchSourceUrl } : {}),
    checkedAt: input.checkedAt,
    ...(input.professorName ? { professorName: input.professorName } : {}),
    ...(input.identityQuote ? { identityQuote: input.identityQuote } : {}),
    ...(quoteIsExact ? { researchQuote: input.researchQuote } : {}),
    affiliation: { status: affiliationVerified ? 'verified' : 'uncertain', ...(institution && affiliationVerified ? { institution } : {}), sourceUrl: input.sourceUrl },
    matchedInterests: interests,
    recommendation,
    rationale,
    uncertaintyReasons,
  };
}

function isExactOfficialSource(value: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function containsName(text: string, name: string): boolean {
  const pattern = new RegExp(name.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
  return pattern.test(text);
}

function normalizeName(value: string): string { return value.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
