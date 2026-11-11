import { createHash } from 'node:crypto';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { canonicalizeSourceUrl } from './research-discovery.ts';

export type ConfirmedResearchStatus = 'matched' | 'evidence_found_but_not_matched' | 'no_research_evidence' | 'not_evaluated';

export interface ConfirmedProfessor {
  stableId: string;
  name: string;
  institution: string;
  country: string;
  officialProfileUrl: string;
  researchEvidence: Array<{ quote: string; sourceUrl: string }>;
  researchStatus: ConfirmedResearchStatus;
  researchStatusExplanation: string;
  duplicate: boolean;
  sourceReports: string[];
  localOwnerDecision: 'pending' | 'accepted_local_only';
  approved: false;
  queued: false;
  sent: false;
}

export interface ConfirmedProfessorReportInput {
  reportName: string;
  country?: string;
  candidates: unknown;
}

export interface ConfirmedProfessorDiagnosticInput {
  reportName: string;
  kind: 'replay' | 'reevaluation';
  sourceReport?: string;
  candidates: unknown;
}

export interface LocalOwnerDecisionInput {
  ownerDecision?: unknown;
  decisionScope?: unknown;
  mongoSaved?: unknown;
  sourceReport?: unknown;
  candidate?: {
    professorName?: unknown;
    institution?: unknown;
    officialProfileUrl?: unknown;
    researchEvidenceQuote?: unknown;
    researchEvidenceSourceUrl?: unknown;
    savedInterestMatchExplanation?: unknown;
  };
}

export interface ConfirmedProfessorParseResult {
  professors: ConfirmedProfessor[];
  excludedByReason: Record<string, number>;
  duplicateRowsConsolidated: number;
}

interface WorkingProfessor extends Omit<ConfirmedProfessor, 'researchStatus' | 'researchStatusExplanation'> {
  claims: { matchedSources: Set<string>; notMatchedSources: Set<string>; noEvidence: boolean };
  invalidResearchSources: Set<string>;
}

function increment(counts: Record<string, number>, code: string): void {
  counts[code] = (counts[code] ?? 0) + 1;
}

function safeText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]')
    .replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function canonicalOfficialProfile(value: unknown, country: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    const hosts = (OFFICIAL_HOSTS_BY_REGION as Record<string, readonly string[]>)[country] ?? [];
    if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname.toLowerCase())) return undefined;
    return canonicalizeSourceUrl(url.toString());
  } catch { return undefined; }
}

function canonicalOfficialEvidence(value: unknown, country: string): string | undefined {
  return canonicalOfficialProfile(value, country);
}

function identityKey(name: string, institution: string): string {
  return `${normalizeIdentity(name)}|${normalizeIdentity(institution)}`;
}

function stableId(canonicalUrl: string): string {
  return `discovery-${createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 24)}`;
}

function addSource(record: WorkingProfessor, source: string): void {
  const value = safeText(source, 180);
  if (value && !record.sourceReports.includes(value) && record.sourceReports.length < 40) record.sourceReports.push(value);
}

function addEvidence(record: WorkingProfessor, country: string, sourceUrl: unknown, quoteText: unknown): void {
  const url = canonicalOfficialEvidence(sourceUrl, country);
  const quote = safeText(quoteText, 500);
  if (!url || !quote) return;
  if (!record.researchEvidence.some((item) => item.sourceUrl === url && item.quote === quote) && record.researchEvidence.length < 20) {
    record.researchEvidence.push({ sourceUrl: url, quote });
  }
}

function acceptedLocalDecision(decision?: LocalOwnerDecisionInput): { key?: string; name?: string; institution?: string; reportName?: string } {
  if (decision?.ownerDecision !== 'accepted' || decision.decisionScope !== 'local_preview_only' || decision.mongoSaved !== false) return {};
  const name = safeText(decision.candidate?.professorName, 160);
  const institution = safeText(decision.candidate?.institution, 180);
  const profile = canonicalOfficialProfile(decision.candidate?.officialProfileUrl, 'Canada');
  return profile && name && institution ? { key: profile, name, institution, reportName: safeText(decision.sourceReport, 180) } : {};
}

function rowMatchClaim(record: WorkingProfessor, row: Record<string, unknown>, evidence: Array<{ sourceUrl: string; quote: string }>): void {
  const sources = new Set(evidence.map((item) => item.sourceUrl));
  if ((row.interestMatch === 'matched' || row.reason === 'passed_all_gates') && sources.size) {
    for (const source of sources) record.claims.matchedSources.add(source);
  }
  if ((row.interestMatch === 'not_matched' || row.reason === 'research_interest_mismatch') && sources.size) {
    for (const source of sources) record.claims.notMatchedSources.add(source);
  }
  if (row.reason === 'research_evidence_missing') record.claims.noEvidence = true;
}

function diagnosticRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row))) : [];
}

/** Combines local report evidence while keeping professor identity and research fit as separate gates. */
export function parseConfirmedProfessorReports(
  reports: ConfirmedProfessorReportInput[],
  localDecision?: LocalOwnerDecisionInput,
  diagnostics: ConfirmedProfessorDiagnosticInput[] = [],
): ConfirmedProfessorParseResult {
  const excludedByReason: Record<string, number> = {};
  const unique = new Map<string, WorkingProfessor>();
  const profileKeys = new Map<string, string>();
  const personKeys = new Map<string, string>();
  const accepted = acceptedLocalDecision(localDecision);
  const replayRecordKeys = new Map<string, string>();
  let duplicateRowsConsolidated = 0;

  for (const report of reports) {
    if (!Array.isArray(report.candidates)) continue;
    for (const value of report.candidates) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        increment(excludedByReason, 'invalid_report_row');
        continue;
      }
      const row = value as Record<string, unknown>;
      if (row.identityVerified !== true) {
        increment(excludedByReason, 'identity_not_established');
        continue;
      }
      // The preview flag is emitted only by the official-page verifier after it finds an individual name and academic role.
      const name = safeText(row.name, 160);
      const institution = safeText(row.institution, 180);
      const country = safeText(row.country, 100) || safeText(report.country, 100);
      if (!name || /^(unidentified result|unknown|n\/a)$/i.test(name)) {
        increment(excludedByReason, 'name_missing');
        continue;
      }
      if (!institution || !country) {
        increment(excludedByReason, 'institution_or_country_missing');
        continue;
      }
      const profileUrl = canonicalOfficialProfile(row.officialProfileSource, country);
      if (!profileUrl) {
        increment(excludedByReason, 'official_profile_not_verified');
        continue;
      }

      const id = stableId(profileUrl);
      const personKey = identityKey(name, institution);
      const existingId = profileKeys.get(profileUrl) ?? personKeys.get(personKey) ?? id;
      const reportName = `${safeText(report.reportName, 150) || 'local discovery preview'}${safeText(row.recordId, 48) ? ` · ${safeText(row.recordId, 48)}` : ''}`;
      const evidence = Array.isArray(row.researchSources) ? row.researchSources.flatMap((source) => {
        if (!source || typeof source !== 'object') return [];
        const item = source as Record<string, unknown>;
        const url = canonicalOfficialEvidence(item.url, country);
        const quote = safeText(item.supportingEvidence, 500);
        return url && quote ? [{ sourceUrl: url, quote }] : [];
      }) : [];
      const existing = unique.get(existingId);
      if (existing) {
        duplicateRowsConsolidated += 1;
        profileKeys.set(profileUrl, existingId);
        personKeys.set(personKey, existingId);
        existing.duplicate = true;
        addSource(existing, reportName);
        for (const item of evidence) addEvidence(existing, country, item.sourceUrl, item.quote);
        rowMatchClaim(existing, row, evidence);
        if (row.duplicate === true) existing.duplicate = true;
        if (accepted.key === profileUrl || (accepted.name && accepted.institution && personKey === identityKey(accepted.name, accepted.institution))) {
          existing.localOwnerDecision = 'accepted_local_only';
        }
        continue;
      }

      const ownerAccepted = accepted.key === profileUrl || (accepted.name && accepted.institution && personKey === identityKey(accepted.name, accepted.institution));
      const record: WorkingProfessor = {
        stableId: existingId,
        name,
        institution,
        country,
        officialProfileUrl: profileUrl,
        researchEvidence: [],
        claims: { matchedSources: new Set(), notMatchedSources: new Set(), noEvidence: false },
        invalidResearchSources: new Set(),
        duplicate: row.duplicate === true,
        sourceReports: [],
        localOwnerDecision: ownerAccepted ? 'accepted_local_only' : 'pending',
        approved: false,
        queued: false,
        sent: false,
      };
      addSource(record, reportName);
      for (const item of evidence) addEvidence(record, country, item.sourceUrl, item.quote);
      rowMatchClaim(record, row, evidence);
      unique.set(existingId, record);
      profileKeys.set(profileUrl, existingId);
      personKeys.set(personKey, existingId);
      if (ownerAccepted && accepted.reportName) addSource(record, accepted.reportName);
    }
  }

  for (const report of [...diagnostics].sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'replay' ? -1 : 1))) {
    const rows = diagnosticRows(report.candidates);
    if (report.kind === 'replay') {
      for (const row of rows) {
        const identity = row.identity && typeof row.identity === 'object' ? row.identity as Record<string, unknown> : {};
        const profile = row.profile && typeof row.profile === 'object' ? row.profile as Record<string, unknown> : {};
        const research = row.research && typeof row.research === 'object' ? row.research as Record<string, unknown> : {};
        const country = 'Canada';
        const profileUrl = canonicalOfficialProfile(profile.sourceUrl, country);
        const id = profileUrl ? profileKeys.get(profileUrl) : undefined;
        if (!id || !unique.has(id) || identity.established !== true) continue;
        const record = unique.get(id)!;
        const recordKey = `${safeText(report.reportName, 180)}|${safeText(row.recordId, 48)}`;
        replayRecordKeys.set(recordKey, id);
        addSource(record, report.reportName);
        const extracted = research.textExtracted === true;
        const observed = Array.isArray(research.observedResearchExcerpts) ? research.observedResearchExcerpts : [];
        if (extracted) {
          for (const item of observed) {
            if (!item || typeof item !== 'object') continue;
            const evidence = item as Record<string, unknown>;
            addEvidence(record, country, evidence.sourceUrl, evidence.excerpt);
          }
          const evaluatedSource = canonicalOfficialEvidence(research.extractedSourceUrl, country);
          if (evaluatedSource && research.observedTextMatchedSavedInterests === true) record.claims.matchedSources.add(evaluatedSource);
          else if (evaluatedSource && research.observedTextMatchedSavedInterests === false) record.claims.notMatchedSources.add(evaluatedSource);
        } else if (['no_research_links', 'research_fetch_failed', 'unsupported_content', 'no_research_text_extracted'].includes(String(row.stopReason))) {
          record.claims.noEvidence = true;
        }
      }
      continue;
    }

    const referencedReport = safeText(report.sourceReport, 180);
    for (const row of rows) {
      const linkedId = replayRecordKeys.get(`${referencedReport}|${safeText(row.recordId, 48)}`);
      const candidateCountry = 'Canada';
      const profileUrl = canonicalOfficialProfile(row.researchSourceUrl, candidateCountry);
      const id = linkedId ?? (profileUrl ? profileKeys.get(profileUrl) : undefined);
      if (!id || !unique.has(id)) continue;
      const record = unique.get(id)!;
      addSource(record, report.reportName);
      const sourceUrl = canonicalOfficialEvidence(row.researchSourceUrl, candidateCountry);
      if (row.researchGate === 'matched' && sourceUrl) {
        record.claims.matchedSources.add(sourceUrl);
        addEvidence(record, candidateCountry, sourceUrl, row.supportingExcerpt);
      } else if (row.researchGate === 'other_named_lead' && sourceUrl) {
        record.invalidResearchSources.add(sourceUrl);
        record.claims.noEvidence = true;
      } else if (row.researchGate === 'not_matched' && sourceUrl) {
        record.claims.notMatchedSources.add(sourceUrl);
        addEvidence(record, candidateCountry, sourceUrl, row.supportingExcerpt);
      }
    }
  }

  if (accepted.key) {
    const id = profileKeys.get(accepted.key) ?? (accepted.name && accepted.institution ? personKeys.get(identityKey(accepted.name, accepted.institution)) : undefined);
    const record = id ? unique.get(id) : undefined;
    if (record) {
      record.localOwnerDecision = 'accepted_local_only';
      if (accepted.reportName) addSource(record, accepted.reportName);
      const owner = localDecision?.candidate;
      addEvidence(record, 'Canada', owner?.researchEvidenceSourceUrl, owner?.researchEvidenceQuote);
      const explanation = typeof owner?.savedInterestMatchExplanation === 'string' ? owner.savedInterestMatchExplanation : '';
      const ownerSource = canonicalOfficialEvidence(owner?.researchEvidenceSourceUrl, 'Canada');
      if (/exact concept-level match/i.test(explanation) && ownerSource) record.claims.matchedSources.add(ownerSource);
    }
  }

  const professors = [...unique.values()].map((record): ConfirmedProfessor => {
    record.researchEvidence = record.researchEvidence.filter((item) => !record.invalidResearchSources.has(item.sourceUrl)).slice(0, 5);
    const evidenceSources = new Set(record.researchEvidence.map((item) => item.sourceUrl));
    const hasMatchedEvidence = [...record.claims.matchedSources].some((source) => evidenceSources.has(source));
    const hasNonMatchedEvidence = [...record.claims.notMatchedSources].some((source) => evidenceSources.has(source));
    const hasEvidence = evidenceSources.size > 0;
    const researchStatus: ConfirmedResearchStatus = hasMatchedEvidence
      ? 'matched'
      : hasNonMatchedEvidence
        ? 'evidence_found_but_not_matched'
        : !hasEvidence && record.claims.noEvidence
          ? 'no_research_evidence'
          : 'not_evaluated';
    const researchStatusExplanation = researchStatus === 'matched'
      ? 'A saved offline evaluation recorded a match between verified research evidence and at least one saved interest; preference wording is omitted.'
      : researchStatus === 'evidence_found_but_not_matched'
        ? 'Official research evidence was saved, and a report explicitly recorded that it did not match the saved interests.'
        : researchStatus === 'no_research_evidence'
          ? 'The reports did not establish attributable official research evidence for this professor.'
          : 'The reports do not contain enough recorded evidence and match results to evaluate research fit.';
    return {
      stableId: record.stableId,
      name: record.name,
      institution: record.institution,
      country: record.country,
      officialProfileUrl: record.officialProfileUrl,
      researchEvidence: record.researchEvidence,
      researchStatus,
      researchStatusExplanation,
      duplicate: record.duplicate,
      sourceReports: record.sourceReports,
      localOwnerDecision: record.localOwnerDecision,
      approved: false,
      queued: false,
      sent: false,
    };
  });

  return { professors, excludedByReason, duplicateRowsConsolidated };
}
