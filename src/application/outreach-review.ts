import { candidateReadinessIssue, type OutreachAttempt, type ProfessorCandidate } from '../domain/outreach-queue.ts';
import { validateOutreachDraft, type OutreachDraft } from './outreach-draft.ts';

function parseSavedDraft(value: string): OutreachDraft {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new Error('Saved draft must use the source-cited draft format'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Saved draft must use the source-cited draft format');
  const draft = parsed as Record<string, unknown>;
  const fields = ['candidateId', 'recipientEmail', 'subject', 'body', 'personalizationSourceUrl', 'personalizationExcerpt', 'generatedAt'];
  if (fields.some((field) => typeof draft[field] !== 'string')) throw new Error('Saved draft must use the source-cited draft format');
  return draft as unknown as OutreachDraft;
}

/** Applies the final human approval state after reviewed sources and a personalized draft exist. */
export function approveCandidateForQueue(candidate: ProfessorCandidate, attempts: OutreachAttempt[]): ProfessorCandidate {
  if (candidate.status !== 'ready-for-review' || candidate.approvedForSending) {
    throw new Error('Candidate must be in ready-for-review state before approval');
  }
  const evidence = candidate.discoveryEvidence ?? [];
  if (!candidate.officialProfileUrl || !evidence.some((item) => item.kind === 'professor-profile' && item.verification === 'reviewed' && item.sourceUrl === candidate.officialProfileUrl)) {
    throw new Error('A reviewed official professor profile is required');
  }
  if (!candidate.emailSourceUrl || !evidence.some((item) => item.kind === 'contact' && item.verification === 'reviewed' && item.sourceUrl === candidate.emailSourceUrl)) {
    throw new Error('A reviewed official contact source is required');
  }
  if (!candidate.programUrl || !evidence.some((item) => item.kind === 'program' && item.verification === 'reviewed' && item.sourceUrl === candidate.programUrl)) {
    throw new Error('A reviewed official program source is required');
  }
  if (candidate.officialContactUrl !== candidate.emailSourceUrl) throw new Error('The selected official contact page must match the email source');
  const approved = { ...candidate, status: 'approved' as const, approvedForSending: true };
  const issue = candidateReadinessIssue(approved);
  if (issue) throw new Error(`Candidate is not ready for queue approval: ${issue}`);
  const draft = parseSavedDraft(approved.personalizedDraft!);
  const draftIssues = validateOutreachDraft(draft, attempts);
  if (draftIssues.length) throw new Error(`Candidate draft failed review: ${draftIssues.join('; ')}`);
  if (draft.candidateId !== approved.id || draft.recipientEmail.trim().toLowerCase() !== approved.officialEmail!.trim().toLowerCase() || draft.personalizationSourceUrl !== approved.officialProfileUrl) {
    throw new Error('Saved draft identity, recipient, and reviewed profile source must match the candidate');
  }
  const professorSource = evidence.find((item) => item.kind === 'professor-profile' && item.sourceUrl === approved.officialProfileUrl);
  if (!professorSource?.excerpt.includes(draft.personalizationExcerpt) ||
      !approved.fitSummary?.includes(draft.personalizationExcerpt) || !approved.fitSummary.includes(approved.officialProfileUrl)) {
    throw new Error('Fit note and draft personalization must use the reviewed professor-profile evidence');
  }
  return approved;
}
