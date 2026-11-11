import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { OutreachAttempt, ProfessorCandidate } from '../domain/outreach-queue.ts';
import { GeminiDraftProvider } from '../infrastructure/gemini-draft-provider.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { matchingResearchInterests } from './professor-research-evidence.ts';

export interface OutreachDraft {
  candidateId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  personalizationSourceUrl: string;
  personalizationExcerpt: string;
  generatedAt: string;
}

export interface LocalOutreachDraftPreview extends Omit<OutreachDraft, 'recipientEmail'> {
  recipientEmail: null;
  recipientStatus: 'unavailable';
  ownerDecision: 'accepted_local_only';
  approved: false;
  queued: false;
  sent: false;
  mongoWrites: 0;
  claimSupport: Array<{ claim: string; evidence: string }>;
}

function cleanExcerpt(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanLine(value: string): string {
  return cleanExcerpt(value);
}

function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function matchingInterest(profile: ApplicantProfile, researchExcerpt: string): string {
  const interests = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields].map((item) => item.trim()).filter(Boolean);
  const matches = matchingResearchInterests(researchExcerpt, interests);
  if (!matches.length) throw new Error('Research evidence must match at least one saved interest before drafting');
  return cleanLine(matches[0]!);
}

function composeMessage(input: {
  professorName: string;
  institution: string;
  profile: ApplicantProfile;
  sourceUrl: string;
  excerpt: string;
  interest: string;
}): { subject: string; body: string } {
  const { profile } = input;
  const degree = profile.applicant.degree;
  const academicContext = degree.title.trim() && degree.institution.trim()
    ? `My academic background is ${cleanLine(degree.title)} at ${cleanLine(degree.institution)}.\n\n`
    : '';
  const projectLinks = profile.applicant.documents.projectUrls.flatMap((value) => {
    if (!isSecureUrl(value.trim())) return [];
    return [new URL(value.trim()).toString()];
  });
  const projectContext = projectLinks.length ? `My project work is available here: ${projectLinks.slice(0, 3).join(', ')}.\n\n` : '';
  const intake = profile.applicant.target.intake.trim();
  const applicantName = cleanLine(profile.applicant.fullName);
  const body = [
    `Dear ${cleanLine(input.professorName)},`,
    '',
    `I am preparing to apply for the ${cleanLine(intake) || 'upcoming'} master's intake and am interested in ${cleanLine(input.institution)}. Your profile says: "${input.excerpt}" This connects with my interest in ${input.interest}.`,
    '',
    `${academicContext}${projectContext}Would you be open to discussing whether your group may be a fit for an incoming master's student?`,
    '',
    'Thank you for your time,',
    applicantName,
    '',
    `Source: ${input.sourceUrl}`,
  ].join('\n');
  return { subject: `Prospective master's applicant interested in ${input.interest}`, body };
}

/** Builds a source-cited draft from a human-selected reviewed fact; it never approves or sends it. */
export function createOutreachDraft(input: {
  candidate: ProfessorCandidate;
  profile: ApplicantProfile;
  researchSourceUrl: string;
  researchExcerpt: string;
  now?: string;
}): OutreachDraft {
  const { candidate, profile } = input;
  if (!candidate.officialProfileUrl || candidate.status !== 'ready-for-review') {
    throw new Error('A reviewed professor profile is required before drafting');
  }
  const professorName = cleanLine(candidate.professorName ?? '');
  const institution = cleanLine(candidate.institution);
  if (!professorName || !institution) throw new Error('Reviewed professor name and institution are required before drafting');
  const source = candidate.discoveryEvidence?.find((item) => item.kind === 'professor-profile' && item.verification === 'reviewed' && item.sourceUrl === input.researchSourceUrl);
  if (!source) throw new Error('Personalization must cite a reviewed professor-profile source');
  if (!candidate.officialEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.officialEmail) || !candidate.emailSourceUrl || !candidate.discoveryEvidence?.some((item) =>
    item.kind === 'contact' && item.verification === 'reviewed' && item.sourceUrl === candidate.emailSourceUrl)) {
    throw new Error('A reviewed official contact source and email address are required before drafting');
  }

  const selectedExcerpt = cleanExcerpt(input.researchExcerpt);
  const officialExcerpt = cleanExcerpt(source.excerpt);
  if (selectedExcerpt.length < 24 || selectedExcerpt.length > 240 || !officialExcerpt.includes(selectedExcerpt)) {
    throw new Error('Personalization excerpt must be a short exact passage from the reviewed source');
  }
  const interest = matchingInterest(profile, selectedExcerpt);
  const applicantName = cleanLine(profile.applicant.fullName);
  if (!applicantName) throw new Error('Applicant name and at least one configured academic interest are required');
  const message = composeMessage({ professorName, institution, profile, sourceUrl: source.sourceUrl, excerpt: selectedExcerpt, interest });
  const generatedAt = new Date(input.now ?? new Date().toISOString());
  if (Number.isNaN(generatedAt.getTime())) throw new Error('now must be a valid date');
  return {
    candidateId: candidate.id,
    recipientEmail: candidate.officialEmail,
    ...message,
    personalizationSourceUrl: source.sourceUrl,
    personalizationExcerpt: selectedExcerpt,
    generatedAt: generatedAt.toISOString(),
  };
}

/** Creates a private draft preview only from an accepted local decision and reverified report evidence. */
export function createLocalAcceptedOutreachDraftPreview(input: {
  candidateId: string;
  professorName: string;
  institution: string;
  country: string;
  officialProfileUrl: string;
  researchSourceUrl: string;
  researchExcerpt: string;
  profile: ApplicantProfile;
  ownerDecision: { decision: 'accepted'; scope: 'local_preview_only'; mongoSaved: false };
  identityEstablished: true;
  researchMatchEstablished: true;
  now?: string;
}): LocalOutreachDraftPreview {
  if (input.ownerDecision.decision !== 'accepted' || input.ownerDecision.scope !== 'local_preview_only' || input.ownerDecision.mongoSaved !== false ||
      input.identityEstablished !== true || input.researchMatchEstablished !== true) {
    throw new Error('Accepted local identity and research evidence are required for a draft preview');
  }
  const hosts = (OFFICIAL_HOSTS_BY_REGION as Record<string, readonly string[]>)[input.country] ?? [];
  for (const value of [input.officialProfileUrl, input.researchSourceUrl]) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname.toLowerCase())) throw new Error('not official');
    } catch { throw new Error('Official profile and research evidence sources are required'); }
  }
  const excerpt = cleanExcerpt(input.researchExcerpt);
  if (excerpt.length < 24 || excerpt.length > 240) throw new Error('Personalization excerpt must be a short exact passage from the saved official evidence');
  const interest = matchingInterest(input.profile, excerpt);
  const generatedAt = new Date(input.now ?? new Date().toISOString());
  if (Number.isNaN(generatedAt.getTime())) throw new Error('now must be a valid date');
  const message = composeMessage({
    professorName: input.professorName, institution: input.institution, profile: input.profile,
    sourceUrl: input.researchSourceUrl, excerpt, interest,
  });
  return {
    candidateId: input.candidateId,
    recipientEmail: null,
    recipientStatus: 'unavailable',
    ...message,
    personalizationSourceUrl: input.researchSourceUrl,
    personalizationExcerpt: excerpt,
    generatedAt: generatedAt.toISOString(),
    ownerDecision: 'accepted_local_only',
    approved: false,
    queued: false,
    sent: false,
    mongoWrites: 0,
    claimSupport: [
      { claim: 'Professor name and academic role', evidence: 'Accepted local report identity fields and identity-established official-page diagnostic.' },
      { claim: 'Institution affiliation', evidence: 'Official institution profile URL and accepted local report institution field.' },
      { claim: 'Quoted research statement', evidence: `Official research evidence at ${input.researchSourceUrl}.` },
      { claim: 'Research-interest connection', evidence: 'Current saved research interests were matched against the quoted official research evidence.' },
      ...(input.profile.applicant.degree.title.trim() && input.profile.applicant.degree.institution.trim()
        ? [{ claim: 'Applicant academic background', evidence: 'Saved primary profile degree title and institution fields; owner-provided, not independently source-verified.' }] : []),
      ...(input.profile.applicant.target.intake.trim()
        ? [{ claim: 'Applicant intended intake', evidence: 'Saved primary profile intake field.' }] : []),
      ...(input.profile.applicant.documents.projectUrls.some((value) => isSecureUrl(value.trim()))
        ? [{ claim: 'Applicant project link availability', evidence: 'Saved primary profile project URL fields.' }] : []),
    ],
  };
}

/** Checks that a draft remains individualized and is not a repeat; passing does not authorize sending. */
export function validateOutreachDraft(draft: OutreachDraft, attempts: OutreachAttempt[]): string[] {
  const issues: string[] = [];
  const fields: Array<keyof OutreachDraft> = ['candidateId', 'recipientEmail', 'subject', 'body', 'personalizationSourceUrl', 'personalizationExcerpt', 'generatedAt'];
  if (fields.some((field) => typeof draft[field] !== 'string' || !draft[field].trim())) return ['draft fields are missing or invalid'];
  if (draft.subject.trim().length < 8 || draft.body.trim().length < 120) issues.push('draft is too short to review');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.recipientEmail)) issues.push('draft recipient email is invalid');
  if (Number.isNaN(new Date(draft.generatedAt).getTime())) issues.push('draft generation date is invalid');
  try {
    const source = new URL(draft.personalizationSourceUrl);
    if (source.protocol !== 'https:' || !source.hostname || source.username || source.password) issues.push('draft source must be a safe HTTPS URL');
  } catch { issues.push('draft source must be a safe HTTPS URL'); }
  if (!draft.body.includes(draft.personalizationExcerpt) || !draft.body.includes(draft.personalizationSourceUrl)) {
    issues.push('draft must retain its cited personalization excerpt');
  }
  const email = draft.recipientEmail.trim().toLowerCase();
  if (attempts.some((attempt) => attempt.state !== 'cancelled' &&
    (attempt.candidateId === draft.candidateId || attempt.recipientEmail.trim().toLowerCase() === email))) {
    issues.push('candidate or recipient has already been scheduled or contacted');
  }
  return issues;
}

/** Generates optional Gemini wording, then applies the same exact-source and duplicate gates as template drafts. */
export async function createGeminiOutreachDraft(input: {
  candidate: ProfessorCandidate;
  profile: ApplicantProfile;
  researchSourceUrl: string;
  researchExcerpt: string;
  attempts: OutreachAttempt[];
  provider?: GeminiDraftProvider;
  now?: string;
}): Promise<OutreachDraft> {
  const base = createOutreachDraft(input);
  const interest = matchingInterest(input.profile, base.personalizationExcerpt);
  const generated = await (input.provider ?? new GeminiDraftProvider()).generate({
    applicantName: input.profile.applicant.fullName,
    academicBackground: [input.profile.applicant.degree.title, input.profile.applicant.degree.institution].filter(Boolean).join(' at ') || 'Not provided',
    interest,
    professorName: input.candidate.professorName ?? '',
    institution: input.candidate.institution,
    verifiedExcerpt: base.personalizationExcerpt,
    sourceUrl: base.personalizationSourceUrl,
    intake: input.profile.applicant.target.intake || 'upcoming',
  });
  const draft = { ...base, subject: generated.subject, body: generated.body };
  const issues = validateOutreachDraft(draft, input.attempts);
  if (issues.length) throw new Error(`Gemini draft failed review validation: ${issues.join('; ')}`);
  return draft;
}
