import type { CandidateEvidenceTriage, EvidenceTriageFact, EvidenceTriageRecommendation, ProfessorCandidate } from '../domain/outreach-queue.ts';
import type { GeminiEvidenceTriageInput } from '../infrastructure/gemini-draft-provider.ts';

const OFFICIAL_EVIDENCE_KINDS = new Set(['official-page', 'professor-profile', 'program']);
const MAX_LEADS = 11;
const MAX_EVIDENCE_PER_LEAD = 2;
const MAX_FACTS_PER_LEAD = 2;
const MAX_QUOTE_LENGTH = 600;

export interface CandidateEvidenceTriageRepository {
  save(triage: CandidateEvidenceTriage): Promise<void>;
}

export interface EvidenceTriageProvider {
  triageEvidence(input: GeminiEvidenceTriageInput): Promise<unknown>;
}

interface PreparedLead {
  leadNumber: number;
  candidate: ProfessorCandidate;
  evidenceBySource: Map<string, string>;
  providerEvidence: GeminiEvidenceTriageInput['leads'][number]['evidence'];
}

/** Produces source-validated AI triage in its own repository, without saving to candidate records. */
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
    input.officialHostsByRegion[candidate.country] ?? [],
  ));
  const withEvidence = prepared.filter((lead) => lead.providerEvidence.length > 0);
  const localUnknowns = prepared.filter((lead) => lead.providerEvidence.length === 0).map((lead) => ({
    candidateId: lead.candidate.id,
    recommendation: 'uncertain' as const,
    facts: [],
  }));

  let generated: unknown = { recommendations: [] };
  if (withEvidence.length > 0) {
    generated = await input.provider.triageEvidence({
      researchCriteria,
      leads: withEvidence.map((lead) => ({ leadNumber: lead.leadNumber, evidence: lead.providerEvidence })),
    });
  }
  const validated = validateTriageResponse(generated, withEvidence);
  const triagedAt = (input.now?.() ?? new Date()).toISOString();
  const recommendations: CandidateEvidenceTriage[] = [...localUnknowns, ...validated]
    .map((item) => ({ ...item, triagedAt }))
    .sort((a, b) => candidateIds.indexOf(a.candidateId) - candidateIds.indexOf(b.candidateId));

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
  const evidenceBySource = new Map<string, string>();
  for (const item of safeEvidence) evidenceBySource.set(item.sourceUrl, item.originalExcerpt);
  return {
    leadNumber,
    candidate,
    evidenceBySource,
    providerEvidence: safeEvidence.map(({ sourceUrl, excerpt }) => ({ sourceUrl, excerpt })),
  };
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

function validateTriageResponse(value: unknown, leads: PreparedLead[]): Array<Omit<CandidateEvidenceTriage, 'triagedAt'>> {
  if (leads.length === 0) return [];
  if (!isRecord(value) || !Array.isArray(value.recommendations) || value.recommendations.length !== leads.length) {
    throw new Error('Gemini triage response must contain one recommendation for every evidence-backed lead');
  }
  const expected = new Map(leads.map((lead) => [lead.leadNumber, lead]));
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
      if (!isRecord(fact) || !hasOnlyKeys(fact, ['sourceUrl', 'quote']) ||
          typeof fact.sourceUrl !== 'string' || typeof fact.quote !== 'string' ||
          !fact.quote.trim() || fact.quote !== fact.quote.trim() || fact.quote.length > MAX_QUOTE_LENGTH || containsContactDetails(fact.quote)) {
        throw new Error('Gemini triage fact has an invalid structure');
      }
      const originalExcerpt = lead.evidenceBySource.get(fact.sourceUrl);
      if (!originalExcerpt || !originalExcerpt.includes(fact.quote)) {
        throw new Error('Gemini triage fact source or exact quote did not match saved official evidence');
      }
      return { sourceUrl: fact.sourceUrl, quote: fact.quote };
    });
    const recommendation = entry.recommendation as EvidenceTriageRecommendation;
    if (recommendation !== 'uncertain' && facts.length === 0) {
      throw new Error('Gemini triage cannot make a likely/unlikely recommendation without an exact supporting quote');
    }
    return { candidateId: lead.candidate.id, recommendation, facts };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
