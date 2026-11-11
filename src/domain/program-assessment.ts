import type { ApplicantProfile } from './applicant-profile.ts';
import { matchingResearchInterests } from './research-interest-match.ts';

export type AssessmentOutcome = 'eligible' | 'unclear' | 'ineligible';
export type OpportunityKind = 'msc_program' | 'scholarship' | 'company_graduate_program';
export type OpportunityReviewStatus = 'pending' | 'approved' | 'rejected';

export interface OfficialEvidence {
  sourceUrl: string;
  checkedAt: string;
  excerpt: string;
  uncertainty: string;
  verification: 'reviewed' | 'unreviewed';
}

export interface ProgramRecord {
  id: string;
  kind?: OpportunityKind;
  institution: string;
  name: string;
  country: string;
  intake: string;
  field?: string;
  degree?: string;
  sourceEvidence?: OfficialEvidence;
  lastCheckedAt?: string;
  reviewStatus?: OpportunityReviewStatus;
  reviewedAt?: string;
  fundingDetails?: { summary: string; evidence: OfficialEvidence };
  compensation?: { summary: string; evidence: OfficialEvidence };
  eligibility?: { summary: string; evidence: OfficialEvidence };
  admissions?: {
    minimumClassification?: string;
    minimumGpa?: { value: number; scale: number };
    evidence: OfficialEvidence;
  };
  english?: {
    acceptedTests: Array<{ name: string; minimumScore: number }>;
    evidence: OfficialEvidence;
  };
  tuition?: {
    amount: number;
    currency: string;
    period: string;
    evidence: OfficialEvidence;
  };
  fundingRoutes?: Array<{
    type: string;
    name: string;
    applicantEligibility?: AssessmentOutcome;
    evidence: OfficialEvidence;
  }>;
  deadline?: { date: string; evidence: OfficialEvidence };
}

/** Stable identity complements source-URL comparison when two official pages describe the same opportunity. */
export function canonicalizeOpportunityIdentity(program: ProgramRecord): string {
  const normalize = (value: string) => value.toLocaleLowerCase('en').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return [program.kind ?? 'msc_program', program.country, program.institution, program.name].map(normalize).join('|');
}

export interface AssessmentFinding {
  outcome: AssessmentOutcome;
  reasons: string[];
  evidence: OfficialEvidence[];
}

export interface ProgramAssessment {
  programId: string;
  assessedAt: string;
  admissions: AssessmentFinding;
  english: AssessmentFinding;
  tuition: AssessmentFinding;
  funding: AssessmentFinding;
  intake: AssessmentFinding;
  deadline: AssessmentFinding;
  overall: AssessmentOutcome;
}

export type OpportunityFit = { outcome: 'potential_fit' | 'unclear' | 'not_a_fit'; reasons: string[] };

/** Describes preference overlap separately from admission or hiring eligibility. */
export function assessOpportunityFit(program: ProgramRecord, profile: ApplicantProfile): OpportunityFit {
  const reasons: string[] = [];
  const fields = profile.applicant.target.fields.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const country = profile.applicant.target.countries.some((value) => value.trim().toLowerCase() === program.country.trim().toLowerCase());
  const fieldKnown = Boolean(program.field?.trim());
  const fieldMatches = fieldKnown && fields.some((value) => program.field!.toLowerCase().includes(value) || value.includes(program.field!.toLowerCase()));
  if (country) reasons.push('Country matches a saved preference.');
  else if (!profile.applicant.target.countries.length) reasons.push('Applicant country preferences are not configured.');
  else reasons.push('Country does not match a saved preference.');
  if (fieldMatches) reasons.push('Field matches a saved preference.');
  else if (!fieldKnown || !fields.length) reasons.push('Field overlap is unknown because the record or saved preferences are incomplete.');
  else reasons.push('Field does not match a saved preference.');
  const matchedInterests = program.sourceEvidence
    ? matchingResearchInterests(program.sourceEvidence.excerpt, profile.applicant.target.researchInterests)
    : [];
  if (matchedInterests.length) reasons.push(`Official-source evidence matches ${matchedInterests.length} saved research interest${matchedInterests.length === 1 ? '' : 's'}.`);
  else if (profile.applicant.target.researchInterests.length) reasons.push('No saved research-interest match is recorded in the official-source excerpt.');
  if (program.kind === 'msc_program' && !program.degree?.trim() && !program.name.toLowerCase().includes('msc')) reasons.push('Degree level is not stated.');
  const mismatch = (profile.applicant.target.countries.length > 0 && !country) || (fieldKnown && fields.length > 0 && !fieldMatches);
  return { outcome: mismatch ? 'not_a_fit' : matchedInterests.length ? 'potential_fit' : 'unclear', reasons };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function nonEmptyText(value: unknown, label: string): string {
  const text = textValue(value, label);
  if (!text.trim()) throw new Error(`${label} must not be empty`);
  return text;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function parseEvidence(value: unknown, label: string, allowUnreviewed = false): OfficialEvidence {
  const input = objectValue(value, label);
  const sourceUrl = textValue(input.sourceUrl, `${label}.sourceUrl`);
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error();
  } catch { throw new Error(`${label}.sourceUrl must be an HTTPS URL without credentials`); }
  const checkedAt = textValue(input.checkedAt, `${label}.checkedAt`);
  if (Number.isNaN(new Date(checkedAt).getTime())) throw new Error(`${label}.checkedAt must be a valid date`);
  if (input.verification !== 'reviewed' && !(allowUnreviewed && input.verification === 'unreviewed')) throw new Error(`${label}.verification must be reviewed`);
  return {
    sourceUrl, checkedAt,
    excerpt: nonEmptyText(input.excerpt, `${label}.excerpt`),
    uncertainty: textValue(input.uncertainty, `${label}.uncertainty`),
    verification: 'reviewed',
  };
}

/** Validates program facts imported from a local file; each recorded fact must carry human-reviewed evidence. */
export function parseProgramRecord(value: unknown, options: { allowUnreviewedEvidence?: boolean } = {}): ProgramRecord {
  const input = objectValue(value, 'program');
  const parseFactEvidence = (value: unknown, label: string) => parseEvidence(value, label, options.allowUnreviewedEvidence === true);
  const result: ProgramRecord = {
    id: nonEmptyText(input.id, 'program.id'),
    institution: nonEmptyText(input.institution, 'program.institution'),
    name: nonEmptyText(input.name, 'program.name'),
    country: nonEmptyText(input.country, 'program.country'),
    intake: textValue(input.intake, 'program.intake'),
  };
  const kind = input.kind ?? 'msc_program';
  if (!['msc_program', 'scholarship', 'company_graduate_program'].includes(String(kind))) throw new Error('program.kind is invalid');
  result.kind = kind as OpportunityKind;
  if (input.field !== undefined) result.field = textValue(input.field, 'program.field');
  if (input.degree !== undefined) result.degree = textValue(input.degree, 'program.degree');
  if (input.sourceEvidence !== undefined) result.sourceEvidence = parseFactEvidence(input.sourceEvidence, 'program.sourceEvidence');
  if (input.lastCheckedAt !== undefined) {
    const checked = textValue(input.lastCheckedAt, 'program.lastCheckedAt');
    if (Number.isNaN(Date.parse(checked))) throw new Error('program.lastCheckedAt must be a valid date');
    result.lastCheckedAt = checked;
  } else if (result.sourceEvidence) result.lastCheckedAt = result.sourceEvidence.checkedAt;
  result.reviewStatus = 'pending';
  for (const field of ['fundingDetails', 'compensation'] as const) if (input[field] !== undefined) {
    const detail = objectValue(input[field], `program.${field}`);
    result[field] = { summary: nonEmptyText(detail.summary, `program.${field}.summary`), evidence: parseFactEvidence(detail.evidence, `program.${field}.evidence`) };
  }
  if (input.eligibility !== undefined) {
    const eligibility = objectValue(input.eligibility, 'program.eligibility');
    result.eligibility = { summary: nonEmptyText(eligibility.summary, 'program.eligibility.summary'), evidence: parseFactEvidence(eligibility.evidence, 'program.eligibility.evidence') };
  }
  if ((input.kind !== undefined || result.kind !== 'msc_program') && !result.sourceEvidence) throw new Error('opportunity requires reviewed official sourceEvidence');
  if (input.admissions !== undefined) {
    const item = objectValue(input.admissions, 'program.admissions');
    const minimumGpa = item.minimumGpa === undefined ? undefined : objectValue(item.minimumGpa, 'program.admissions.minimumGpa');
    const accepted = item.minimumClassification === undefined ? undefined : textValue(item.minimumClassification, 'program.admissions.minimumClassification');
    result.admissions = {
      ...(accepted === undefined ? {} : { minimumClassification: accepted }),
      ...(minimumGpa === undefined ? {} : { minimumGpa: { value: numberValue(minimumGpa.value, 'program.admissions.minimumGpa.value'), scale: numberValue(minimumGpa.scale, 'program.admissions.minimumGpa.scale') } }),
      evidence: parseFactEvidence(item.evidence, 'program.admissions.evidence'),
    };
  }
  if (input.english !== undefined) {
    const item = objectValue(input.english, 'program.english');
    if (!Array.isArray(item.acceptedTests)) throw new Error('program.english.acceptedTests must be an array');
    result.english = {
      acceptedTests: item.acceptedTests.map((entry, index) => {
        const test = objectValue(entry, `program.english.acceptedTests[${index}]`);
        return { name: nonEmptyText(test.name, `program.english.acceptedTests[${index}].name`), minimumScore: numberValue(test.minimumScore, `program.english.acceptedTests[${index}].minimumScore`) };
      }),
      evidence: parseFactEvidence(item.evidence, 'program.english.evidence'),
    };
  }
  if (input.tuition !== undefined) {
    const item = objectValue(input.tuition, 'program.tuition');
    result.tuition = { amount: numberValue(item.amount, 'program.tuition.amount'), currency: textValue(item.currency, 'program.tuition.currency'), period: textValue(item.period, 'program.tuition.period'), evidence: parseFactEvidence(item.evidence, 'program.tuition.evidence') };
  }
  if (input.fundingRoutes !== undefined) {
    if (!Array.isArray(input.fundingRoutes)) throw new Error('program.fundingRoutes must be an array');
    result.fundingRoutes = input.fundingRoutes.map((entry, index) => {
      const route = objectValue(entry, `program.fundingRoutes[${index}]`);
      const eligibility = route.applicantEligibility;
      if (eligibility !== undefined && !['eligible', 'unclear', 'ineligible'].includes(String(eligibility))) throw new Error(`program.fundingRoutes[${index}].applicantEligibility is invalid`);
      return {
        type: nonEmptyText(route.type, `program.fundingRoutes[${index}].type`),
        name: nonEmptyText(route.name, `program.fundingRoutes[${index}].name`),
        ...(eligibility === undefined ? {} : { applicantEligibility: eligibility as AssessmentOutcome }),
        evidence: parseFactEvidence(route.evidence, `program.fundingRoutes[${index}].evidence`),
      };
    });
  }
  if (input.deadline !== undefined) {
    const item = objectValue(input.deadline, 'program.deadline');
    const date = textValue(item.date, 'program.deadline.date');
    if (Number.isNaN(new Date(date).getTime())) throw new Error('program.deadline.date must be a valid date');
    result.deadline = { date, evidence: parseFactEvidence(item.evidence, 'program.deadline.evidence') };
  }
  return result;
}

const CLASSIFICATION_RANK: Record<string, number> = {
  first: 4, 'first class': 4, 'first-class': 4, '1st': 4,
  'upper second': 3, 'upper second class': 3, '2:1': 3, '2.1': 3,
  'lower second': 2, 'lower second class': 2, '2:2': 2, '2.2': 2,
  third: 1, 'third class': 1,
};

function normalizeClassification(value: string): { key: string; rank?: number } {
  const key = value.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  const embeddedRank = /\b(?:1st|first class)\b/.test(key) ? 4
    : /\b(?:2:1|2\.1|upper second)\b/.test(key) ? 3
      : /\b(?:2:2|2\.2|lower second)\b/.test(key) ? 2
        : /\b(?:third|3rd)\b/.test(key) ? 1 : undefined;
  const rank = CLASSIFICATION_RANK[key] ?? embeddedRank;
  return { key, ...(rank === undefined ? {} : { rank }) };
}

function evidenceIsUsable(evidence: OfficialEvidence | undefined, assessedAt: Date): evidence is OfficialEvidence {
  if (!evidence || evidence.verification !== 'reviewed' || !evidence.sourceUrl.trim() || !evidence.excerpt.trim() || evidence.uncertainty.trim()) return false;
  try {
    const url = new URL(evidence.sourceUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return false;
  } catch { return false; }
  const checkedAt = new Date(evidence.checkedAt);
  return !Number.isNaN(checkedAt.getTime()) && checkedAt <= assessedAt;
}

function finding(outcome: AssessmentOutcome, reason: string, evidence?: OfficialEvidence): AssessmentFinding {
  return { outcome, reasons: [reason], evidence: evidence ? [evidence] : [] };
}

function combine(parts: AssessmentFinding[]): AssessmentFinding {
  const outcome: AssessmentOutcome = parts.some((part) => part.outcome === 'ineligible')
    ? 'ineligible'
    : parts.every((part) => part.outcome === 'eligible') ? 'eligible' : 'unclear';
  return {
    outcome,
    reasons: parts.flatMap((part) => part.reasons),
    evidence: [...new Map(parts.flatMap((part) => part.evidence).map((item) => [`${item.sourceUrl}|${item.checkedAt}`, item])).values()],
  };
}

/** Compares explicit official program facts to profile fields; absent or mismatched evidence remains unclear. */
export function assessProgram(input: {
  program: ProgramRecord;
  profile: ApplicantProfile;
  assessedAt?: string;
}): ProgramAssessment {
  const assessedAt = new Date(input.assessedAt ?? new Date().toISOString());
  if (Number.isNaN(assessedAt.getTime())) throw new Error('assessedAt must be a valid date');
  const { program, profile } = input;
  const degree = profile.applicant.degree;

  const admissionParts: AssessmentFinding[] = [];
  if (!program.admissions || !evidenceIsUsable(program.admissions.evidence, assessedAt)) {
    admissionParts.push(finding('unclear', 'Official admissions evidence is missing, invalid, or checked after this assessment.'));
  } else {
    const requirements = program.admissions;
    if (requirements.minimumClassification) {
      const applicantClass = normalizeClassification(degree.classification);
      const minimum = normalizeClassification(requirements.minimumClassification);
      const matches = applicantClass.key === minimum.key ||
        (minimum.rank !== undefined && applicantClass.rank !== undefined && applicantClass.rank >= minimum.rank);
      const classOutcome: AssessmentOutcome = !degree.classification.trim() || (!matches && minimum.rank === undefined && applicantClass.rank === undefined)
        ? 'unclear' : matches ? 'eligible' : 'ineligible';
      admissionParts.push(finding(classOutcome,
        classOutcome === 'unclear' ? !degree.classification.trim() ? 'Applicant degree classification is not provided.' : 'Classification labels are not comparable without an explicit equivalence.'
          : matches ? 'Applicant classification meets the documented minimum.' : 'Applicant classification does not meet the documented minimum.', requirements.evidence));
    }
    if (requirements.minimumGpa) {
      const minimum = requirements.minimumGpa;
      const hasGpa = degree.gpa !== null && degree.gpaScale !== null;
      const sameScale = hasGpa && degree.gpaScale === minimum.scale;
      const validMinimum = Number.isFinite(minimum.value) && minimum.value >= 0 && Number.isFinite(minimum.scale) && minimum.scale > 0;
      admissionParts.push(finding(!validMinimum || !hasGpa || !sameScale ? 'unclear' : degree.gpa! >= minimum.value ? 'eligible' : 'ineligible',
        !validMinimum ? 'The recorded GPA threshold or scale is invalid.' : !hasGpa ? 'Applicant GPA or grading scale is not provided.' : !sameScale ? 'Applicant and program GPA scales differ; no conversion was inferred.' : degree.gpa! >= minimum.value ? 'Applicant GPA meets the documented minimum on the same scale.' : 'Applicant GPA is below the documented minimum on the same scale.', requirements.evidence));
    }
    if (admissionParts.length === 0) admissionParts.push(finding('unclear', 'Official admissions source was checked, but no supported classification or GPA rule was recorded.', requirements.evidence));
  }

  const englishEvidence = program.english?.evidence;
  let english: AssessmentFinding;
  if (!program.english || !evidenceIsUsable(englishEvidence, assessedAt) || program.english.acceptedTests.length === 0) {
    english = finding('unclear', 'A dated official English-language requirement is not available.');
  } else {
    const applicant = profile.applicant.englishEvidence;
    const applicantScore = /^\s*\d+(?:\.\d+)?\s*$/.test(applicant.score) ? Number(applicant.score) : undefined;
    const accepted = program.english.acceptedTests.find((item) => item.name.toLowerCase() === applicant.testName.trim().toLowerCase());
    english = finding(applicant.testStatus.toLowerCase() !== 'complete' || !accepted || !Number.isFinite(accepted.minimumScore) || accepted.minimumScore < 0 || applicantScore === undefined
      ? 'unclear' : applicantScore >= accepted.minimumScore ? 'eligible' : 'ineligible',
    applicant.testStatus.toLowerCase() !== 'complete' ? 'Applicant English-test result is not recorded as complete.'
      : !accepted ? 'The applicant test is not listed as an accepted test, or its name differs.'
        : applicantScore === undefined ? 'Applicant English score is not a plain numeric value that can be compared safely.'
          : applicantScore >= accepted.minimumScore ? 'Applicant score meets the documented minimum.' : 'Applicant score is below the documented minimum.', englishEvidence);
  }

  const requestedFunding = new Set(profile.applicant.target.fundingTypes.map((item) => item.trim().toLowerCase()));
  const availableFunding = (program.fundingRoutes ?? []).filter((route) => evidenceIsUsable(route.evidence, assessedAt));
  const matchingFunding = availableFunding.filter((route) => requestedFunding.has(route.type.trim().toLowerCase()));
  const funding = availableFunding.length === 0
    ? finding('unclear', 'No dated official funding-route evidence is available.')
      : requestedFunding.size === 0
        ? { ...finding('unclear', 'Applicant funding preferences are not configured.'), evidence: availableFunding.map((route) => route.evidence) }
      : matchingFunding.length > 0
      ? combine(matchingFunding.map((route) => finding(route.applicantEligibility ?? 'unclear',
        route.applicantEligibility === 'eligible' ? `Documented funding route matches preference and recorded criteria: ${route.name}.`
          : route.applicantEligibility === 'ineligible' ? `Documented funding route matches preference, but recorded criteria are not met: ${route.name}.`
            : `Documented funding route matches preference, but applicant eligibility is unresolved: ${route.name}.`, route.evidence)))
      : { ...finding('ineligible', 'No documented funding route matches the applicant funding preferences.'), evidence: availableFunding.map((route) => route.evidence) };

  const tuition = !program.tuition || !evidenceIsUsable(program.tuition.evidence, assessedAt) ||
    !Number.isFinite(program.tuition.amount) || program.tuition.amount < 0 || !program.tuition.currency.trim() || !program.tuition.period.trim()
    ? finding('unclear', 'A dated official tuition amount and currency are not available.')
    : profile.applicant.target.maxAnnualTuition === null || !profile.applicant.target.tuitionCurrency.trim()
      ? finding('unclear', 'Tuition is documented, but the applicant annual budget or currency is not configured.', program.tuition.evidence)
      : !/annual|year/i.test(program.tuition.period)
        ? finding('unclear', 'Tuition period is not annual, so it cannot be compared with the annual budget.', program.tuition.evidence)
        : program.tuition.currency.trim().toUpperCase() !== profile.applicant.target.tuitionCurrency.trim().toUpperCase()
          ? finding('unclear', 'Program and applicant budget currencies differ; no exchange-rate conversion was inferred.', program.tuition.evidence)
          : finding(program.tuition.amount <= profile.applicant.target.maxAnnualTuition ? 'eligible' : 'ineligible',
            program.tuition.amount <= profile.applicant.target.maxAnnualTuition ? 'Documented annual tuition is within the configured applicant budget.' : 'Documented annual tuition exceeds the configured applicant budget.', program.tuition.evidence);

  const applicantIntake = profile.applicant.target.intake.trim();
  const programYear = /\b20\d{2}\b/.exec(program.intake)?.[0];
  const targetYear = /\b20\d{2}\b/.exec(applicantIntake)?.[0];
  const intake = !program.intake.trim()
    ? finding('unclear', 'Program intake is not recorded.')
    : !applicantIntake
      ? finding('unclear', 'Applicant target intake is not recorded.')
      : program.intake.trim().toLowerCase() === applicantIntake.toLowerCase()
        ? finding('eligible', 'Program intake matches the configured applicant target.')
        : programYear && targetYear && programYear === targetYear
          ? finding('unclear', 'Program and applicant intake labels differ; the specific term requires review.')
          : finding('ineligible', 'Program intake does not match the configured applicant target.');

  let deadline: AssessmentFinding;
  if (!program.deadline || !evidenceIsUsable(program.deadline.evidence, assessedAt) || Number.isNaN(new Date(program.deadline.date).getTime())) {
    deadline = finding('unclear', 'A dated official application deadline is not available.');
  } else {
    const deadlineDate = new Date(program.deadline.date);
    deadline = finding(deadlineDate >= assessedAt ? 'eligible' : 'ineligible', deadlineDate >= assessedAt ? 'Documented deadline has not passed.' : 'Documented deadline has passed.', program.deadline.evidence);
  }

  const findings = [combine(admissionParts), english, tuition, funding, intake, deadline];
  const overall: AssessmentOutcome = findings.some((item) => item.outcome === 'ineligible')
    ? 'ineligible' : findings.every((item) => item.outcome === 'eligible') ? 'eligible' : 'unclear';
  return { programId: program.id, assessedAt: assessedAt.toISOString(), admissions: findings[0]!, english, tuition, funding, intake, deadline, overall };
}
