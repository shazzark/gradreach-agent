import type { CandidateEvidenceTriage, EvidenceTriageFact, EvidenceTriageRecommendation, ProfessorCandidate } from '../domain/outreach-queue.ts';
import type { GeminiEvidenceTriageInput } from '../infrastructure/gemini-draft-provider.ts';

const OFFICIAL_EVIDENCE_KINDS = new Set(['official-page', 'professor-profile', 'program']);
const PROFESSOR_EVIDENCE_KINDS = new Set(['professor-profile']);
const MAX_LEADS = 11;
const MAX_EVIDENCE_PER_LEAD = 2;
const MAX_FACTS_PER_LEAD = 2;
const MAX_QUOTE_LENGTH = 600;
const MAX_RATIONALE_LENGTH = 240;
const GENERIC_LEAD_TERMS = new Set([
  'school', 'department', 'faculty', 'program', 'professor', 'professors', 'research', 'laboratory', 'lab',
  'course', 'center', 'centre', 'institute', 'university', 'college', 'computing', 'computer', 'science',
  'cybersecurity', 'security', 'privacy', 'systems', 'networking', 'robotics',
]);
const GENERIC_RESEARCH_TERMS = new Set([
  'a', 'an', 'and', 'are', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with',
  'research', 'researches', 'researching', 'work', 'works', 'study', 'studies', 'group', 'lab', 'laboratory',
  'computer', 'science', 'department', 'school', 'faculty', 'program', 'university', 'systems', 'system',
]);
const RESEARCH_SIGNAL = /\b(researches|studies|investigates|develops|explores|focuses|works?\s+on)\b/i;

export interface CandidateEvidenceTriageRepository {
  save(triage: CandidateEvidenceTriage): Promise<void>;
}

export interface EvidenceTriageProvider {
  triageEvidence(input: GeminiEvidenceTriageInput): Promise<unknown>;
}

interface SafeEvidence {
  sourceUrl: string;
  originalExcerpt: string;
  excerpt: string;
  kind: string;
}

interface PreparedLead {
  leadNumber: number;
  candidate: ProfessorCandidate;
  personName?: string;
  isProfessorProfile: boolean;
  hasIdentityAndResearchOnSamePage: boolean;
  evidenceBySource: Map<string, Array<{ originalExcerpt: string; suppliedExcerpt: string }>>;
  safeEvidence: SafeEvidence[];
  providerEvidence: GeminiEvidenceTriageInput['leads'][number]['evidence'];
  identityQuote?: EvidenceTriageFact;
  researchQuote?: EvidenceTriageFact;
}

/** Produces conservative, source-validated triage in its own repository. */
export async function triageCandidateEvidence(input: {
  candidates: ProfessorCandidate[];
  researchCriteria: string[];
  officialHostsByRegion: Record<string, readonly string[]>;
  provider: EvidenceTriageProvider;
  repository: CandidateEvidenceTriageRepository;
  now?: () => Date;
}): Promise<CandidateEvidenceTriage[]> {
  if (input.candidates.length < 1 || input.candidates.length > MAX_LEADS) {
    throw new Error(`Evidence triage supports 1 to ${MAX_LEADS} candidates per batch`);
  }
  const candidateIds = input.candidates.map((candidate) => candidate.id);
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error('Evidence triage candidate IDs must be unique');
  const researchCriteria = [...new Set(input.researchCriteria.map((item) => item.trim()).filter(Boolean))];
  if (researchCriteria.length === 0 || researchCriteria.length > 10 || researchCriteria.some((item) => item.length > 300)) {
    throw new Error('Evidence triage requires 1 to 10 bounded research criteria');
  }

  const prepared = input.candidates.map((candidate, index) => prepareLead(
    candidate,
    index + 1,
    input.officialHostsByRegion[candidate.searchRegion ?? candidate.country] ?? [],
  ));
  const eligibleLeads = prepared.filter((lead) => lead.personName && lead.isProfessorProfile && lead.identityQuote && lead.researchQuote && lead.hasIdentityAndResearchOnSamePage);
  const localUnknowns = prepared.filter((lead) => !eligibleLeads.includes(lead)).map((lead) => localUncertain(lead));

  let generated: unknown = { recommendations: [] };
  if (eligibleLeads.length > 0) {
    generated = await input.provider.triageEvidence({
      researchCriteria,
      leads: eligibleLeads.map((lead) => ({
        leadNumber: lead.leadNumber,
        leadName: lead.personName!,
        evidence: lead.providerEvidence,
      })),
    });
  }
  const validated = validateTriageResponse(generated, eligibleLeads, researchCriteria);
  const triagedAt = (input.now?.() ?? new Date()).toISOString();
  const recommendations: CandidateEvidenceTriage[] = [...localUnknowns, ...validated]
    .map((item) => ({ ...item, triagedAt }))
    .sort((a, b) => candidateIds.indexOf(a.candidateId) - candidateIds.indexOf(b.candidateId));
  if (recommendations.some((item) => item.rationale.length > MAX_RATIONALE_LENGTH)) {
    throw new Error('Evidence triage rationale exceeds its length bound');
  }

  for (const recommendation of recommendations) await input.repository.save(recommendation);
  return recommendations;
}

function prepareLead(candidate: ProfessorCandidate, leadNumber: number, allowedHosts: readonly string[]): PreparedLead {
  const safeEvidence = (candidate.discoveryEvidence ?? [])
    .filter((item) => OFFICIAL_EVIDENCE_KINDS.has(item.kind))
    .flatMap((item) => {
      const sourceUrl = safeSourceUrl(item.sourceUrl, allowedHosts);
      const excerpt = redactContactDetails(item.excerpt).slice(0, 1200);
      return sourceUrl && excerpt.trim() ? [{ sourceUrl, originalExcerpt: item.excerpt, excerpt, kind: item.kind }] : [];
    })
    .sort((a, b) => evidencePriority(a.kind) - evidencePriority(b.kind))
    .slice(0, MAX_EVIDENCE_PER_LEAD);
  const evidenceBySource = new Map<string, Array<{ originalExcerpt: string; suppliedExcerpt: string }>>();
  for (const item of safeEvidence) {
    const sources = evidenceBySource.get(item.sourceUrl) ?? [];
    sources.push({ originalExcerpt: item.originalExcerpt, suppliedExcerpt: item.excerpt });
    evidenceBySource.set(item.sourceUrl, sources);
  }

  const personName = personNameFromLeadTitle(candidate.name);
  const profileUrl = candidate.officialProfileUrl ? safeSourceUrl(candidate.officialProfileUrl, allowedHosts) : undefined;
  const professorEvidence = safeEvidence.filter((item) => PROFESSOR_EVIDENCE_KINDS.has(item.kind) || (profileUrl && profileUrl === item.sourceUrl));
  const identityPredicate = (quote: string) => Boolean(personName && containsPersonName(quote, personName));
  const profilePair = professorEvidence.map((item) => ({
    identity: personName ? findExactFact([item], 'identity', identityPredicate) : undefined,
    research: findExactFact([item], 'research', hasSubstantiveResearchSignal),
  })).find((pair) => pair.identity && pair.research);
  const identityQuote = profilePair?.identity ?? (personName ? findExactFact(professorEvidence, 'identity', identityPredicate) : undefined);
  const researchQuote = profilePair?.research ?? findExactFact(professorEvidence, 'research', hasSubstantiveResearchSignal);

  return {
    leadNumber,
    candidate,
    ...(personName ? { personName } : {}),
    isProfessorProfile: professorEvidence.length > 0,
    hasIdentityAndResearchOnSamePage: Boolean(profilePair),
    evidenceBySource,
    safeEvidence,
    providerEvidence: safeEvidence.map(({ sourceUrl, excerpt }) => ({ sourceUrl, excerpt })),
    ...(identityQuote ? { identityQuote } : {}),
    ...(researchQuote ? { researchQuote } : {}),
  };
}

function localUncertain(lead: PreparedLead): Omit<CandidateEvidenceTriage, 'triagedAt'> {
  const hasEvidence = lead.safeEvidence.length > 0;
  const rationale = !hasEvidence
    ? 'No allowlisted official-page excerpt is available, so relevance remains unknown.'
    : !lead.isProfessorProfile
      ? 'The saved page is a general school or program source, not a professor research profile; relevance remains uncertain.'
      : !lead.identityQuote
        ? 'The official profile does not explicitly identify this lead, so professor relevance remains uncertain.'
        : !lead.hasIdentityAndResearchOnSamePage
          ? 'The saved profile does not establish the professor identity and research details together, so relevance remains uncertain.'
          : 'The official profile does not describe specific research that matches the configured interests, so relevance remains uncertain.';
  const context = lead.safeEvidence.map((item) => contextFact(item)).find((fact): fact is EvidenceTriageFact => Boolean(fact));
  return {
    candidateId: lead.candidate.id,
    recommendation: 'uncertain',
    rationale,
    facts: context ? [context] : [],
  };
}

function contextFact(evidence: SafeEvidence): EvidenceTriageFact | undefined {
  const quote = exactSafeContextQuote(evidence.originalExcerpt);
  return quote && evidence.excerpt.includes(quote) ? { kind: 'context', sourceUrl: evidence.sourceUrl, quote } : undefined;
}

function exactSafeContextQuote(excerpt: string): string | undefined {
  const sentences = excerpt.split(/(?<=[.!?])\s+|\r?\n/).map((item) => item.trim()).filter(Boolean);
  const quote = sentences.find((item) => item.length <= MAX_QUOTE_LENGTH && !containsContactDetails(item));
  if (quote) return quote;
  const trimmed = excerpt.trim();
  return trimmed.length <= MAX_QUOTE_LENGTH && !containsContactDetails(trimmed) ? trimmed : undefined;
}

function personNameFromLeadTitle(value: string): string | undefined {
  const heading = value.split(/\s+(?:\||—|–)\s+/)[0]?.trim().replace(/^(?:professor|prof\.?|dr\.?)\s+/i, '').replace(/\s+(?:laboratory|lab)$/i, '');
  if (!heading || GENERIC_LEAD_TERMS.has(heading.toLowerCase())) return undefined;
  const tokens = heading.split(/\s+/).filter(Boolean);
  if (heading.length > 120 || tokens.length < 2 || tokens.length > 4 || tokens.some((token) => GENERIC_LEAD_TERMS.has(token.toLowerCase()))) return undefined;
  if (tokens.some((token) => !/^[\p{L}][\p{L}.'’-]*$/u.test(token))) return undefined;
  return tokens.join(' ');
}

function containsPersonName(value: string, personName: string): boolean {
  return personName.split(/\s+/).every((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(value));
}

function findExactFact(evidence: SafeEvidence[], kind: EvidenceTriageFact['kind'], predicate: (quote: string) => boolean): EvidenceTriageFact | undefined {
  for (const item of evidence) {
    const sentences = item.originalExcerpt.split(/(?<=[.!?])\s+|\r?\n/).map((part) => part.trim()).filter(Boolean);
    const quote = sentences.find((part) => item.excerpt.includes(part) && part.length <= MAX_QUOTE_LENGTH && !containsContactDetails(part) && predicate(part));
    if (quote) return { kind, sourceUrl: item.sourceUrl, quote };
  }
  return undefined;
}

function hasSubstantiveResearchSignal(value: string): boolean {
  return value.length >= 50 && /[.!?]$/.test(value.trim()) && RESEARCH_SIGNAL.test(value);
}

function extractInterestTerms(criteria: string[]): string[] {
  return [...new Set(criteria.flatMap((criterion) => criterion.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length > 2 && !GENERIC_RESEARCH_TERMS.has(term)))];
}

function matchesInterests(quote: string, terms: string[]): boolean {
  const words = new Set(quote.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return terms.some((term) => words.has(term));
}

function evidencePriority(kind: string): number {
  return kind === 'professor-profile' ? 0 : kind === 'official-page' ? 1 : 2;
}

function safeSourceUrl(value: string, allowedHosts: readonly string[]): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.includes(url.hostname.toLowerCase())) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function redactContactDetails(value: string): string {
  return value
    .replace(emailPattern(), '[contact redacted]')
    .replace(phonePattern(), '[contact redacted]');
}

function emailPattern(): RegExp { return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi; }
function phonePattern(): RegExp { return /\+?\d(?:[\d\s().-]{6,}\d)/g; }
function containsContactDetails(value: string): boolean {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) || /\+?\d(?:[\d\s().-]{6,}\d)/.test(value);
}

function validateTriageResponse(value: unknown, leads: PreparedLead[], criteria: string[]): Array<Omit<CandidateEvidenceTriage, 'triagedAt'>> {
  if (leads.length === 0) return [];
  if (!isRecord(value) || !Array.isArray(value.recommendations) || value.recommendations.length !== leads.length) {
    throw new Error('Gemini triage response must contain one recommendation for every evidence-backed professor lead');
  }
  const expected = new Map(leads.map((lead) => [lead.leadNumber, lead]));
  const interestTerms = extractInterestTerms(criteria);
  const seen = new Set<number>();
  return value.recommendations.map((entry): Omit<CandidateEvidenceTriage, 'triagedAt'> => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['leadNumber', 'recommendation', 'facts']) ||
        !Number.isInteger(entry.leadNumber) || typeof entry.leadNumber !== 'number' ||
        !['likely relevant', 'uncertain', 'unlikely'].includes(String(entry.recommendation)) ||
        !Array.isArray(entry.facts) || entry.facts.length > MAX_FACTS_PER_LEAD) {
      throw new Error('Gemini triage recommendation has an invalid structure');
    }
    const lead = expected.get(entry.leadNumber);
    if (!lead || seen.has(entry.leadNumber)) throw new Error('Gemini triage returned an unknown or duplicate lead number');
    seen.add(entry.leadNumber);
    const facts: EvidenceTriageFact[] = entry.facts.map((fact): EvidenceTriageFact => {
      if (!isRecord(fact) || !hasOnlyKeys(fact, ['kind', 'sourceUrl', 'quote']) ||
          !['identity', 'research'].includes(String(fact.kind)) ||
          typeof fact.sourceUrl !== 'string' || typeof fact.quote !== 'string' ||
          !fact.quote.trim() || fact.quote !== fact.quote.trim() || fact.quote.length > MAX_QUOTE_LENGTH || containsContactDetails(fact.quote)) {
        throw new Error('Gemini triage fact has an invalid structure');
      }
      const sourceUrl = fact.sourceUrl;
      const quote = fact.quote;
      const kind = fact.kind as EvidenceTriageFact['kind'];
      const evidence = lead.evidenceBySource.get(sourceUrl)?.some((item) =>
        item.originalExcerpt.includes(quote) && item.suppliedExcerpt.includes(quote));
      if (!evidence) {
        throw new Error('Gemini triage fact source or exact quote did not match saved official evidence');
      }
      if (kind === 'identity' && !containsPersonName(quote, lead.personName!)) {
        throw new Error('Gemini identity quote does not identify the professor lead');
      }
      if (kind === 'research' && !hasSubstantiveResearchSignal(quote)) {
        throw new Error('Gemini research quote is too general to support professor relevance');
      }
      return { kind, sourceUrl, quote };
    });
    const returnedIdentity = facts.find((fact) => fact.kind === 'identity');
    const returnedResearch = facts.find((fact) => fact.kind === 'research');
    const identityFact = returnedIdentity ?? lead.identityQuote;
    const researchFact = returnedResearch ?? lead.researchQuote;
    const researchMatches = researchFact !== undefined && matchesInterests(researchFact.quote, interestTerms);
    const completeFacts = [identityFact, researchFact].filter((fact): fact is EvidenceTriageFact => Boolean(fact));
    let recommendation = entry.recommendation as EvidenceTriageRecommendation;
    if (!identityFact || !researchFact || identityFact.sourceUrl !== researchFact.sourceUrl || !lead.hasIdentityAndResearchOnSamePage ||
        (recommendation === 'likely relevant' && !researchMatches) ||
        (recommendation === 'unlikely' && researchMatches)) {
      recommendation = 'uncertain';
    }
    const rationale = buildRationale(recommendation, lead, identityFact, researchFact, researchMatches);
    return { candidateId: lead.candidate.id, recommendation, rationale, facts: completeFacts };
  });
}

function buildRationale(
  recommendation: EvidenceTriageRecommendation,
  lead: PreparedLead,
  identityFact: EvidenceTriageFact | undefined,
  researchFact: EvidenceTriageFact | undefined,
  researchMatches: boolean,
): string {
  if (recommendation === 'likely relevant') return `The official profile identifies ${lead.personName} and describes research matching the configured interests.`;
  if (recommendation === 'unlikely') return `The official profile identifies ${lead.personName}, but its cited research does not match the configured interests.`;
  if (!lead.isProfessorProfile || !lead.personName) return 'The saved page is general discovery evidence and does not identify a professor with relevant research.';
  if (!identityFact) return 'The saved official evidence does not explicitly identify this professor, so relevance remains uncertain.';
  if (!researchFact) return 'The saved official evidence does not describe specific research or lab work, so relevance remains uncertain.';
  if (identityFact.sourceUrl !== researchFact.sourceUrl || !lead.hasIdentityAndResearchOnSamePage) return 'The saved profile does not establish the professor identity and research details together, so relevance remains uncertain.';
  if (!researchMatches) return 'The cited research is specific but does not establish a match to the configured interests.';
  return 'The cited identity and research are explicit, but the available evidence does not establish a confident fit.';
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
