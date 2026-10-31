import type { ProfessorCandidate } from '../domain/outreach-queue.ts';

function validatePendingProfessorLead(candidate: ProfessorCandidate): void {
  if (candidate.leadType !== 'professor_profile' || candidate.status !== 'needs-evidence' || candidate.discoveryReview || candidate.approvedForSending) {
    throw new Error('Only undecided professor leads in needs-evidence status can be reviewed');
  }
}

function reviewTimestamp(reviewedAt: string): string {
  const timestamp = new Date(reviewedAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error('reviewedAt must be a valid date');
  return timestamp.toISOString();
}

/** Accepts a displayed professor lead while leaving final outreach approval to its separate gate. */
export function acceptDiscoveredProfessorLead(candidate: ProfessorCandidate, reviewedAt = new Date().toISOString()): ProfessorCandidate {
  validatePendingProfessorLead(candidate);
  const sourceUrl = candidate.officialProfileUrl;
  const evidence = candidate.discoveryEvidence ?? [];
  const profile = evidence.find((item) => item.kind === 'professor-profile' && item.sourceUrl === sourceUrl);
  const professorName = candidate.professorName?.trim();
  const nameSupported = professorName && profile && new RegExp(
    professorName.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i',
  ).test(profile.excerpt);
  if (!professorName || !sourceUrl || !profile || !nameSupported) {
    throw new Error('A fetched official professor profile is required to accept this lead');
  }
  const emailSource = candidate.emailSourceUrl;
  const reviewedEvidence = evidence.map((item) => ({
    ...item,
    ...(item.kind === 'professor-profile' && item.sourceUrl === sourceUrl ? { verification: 'reviewed' as const } : {}),
    ...(candidate.officialEmail && emailSource && item.kind === 'contact' && item.sourceUrl === emailSource ? { verification: 'reviewed' as const } : {}),
  }));
  return {
    ...candidate,
    discoveryEvidence: reviewedEvidence,
    discoveryReview: { decision: 'accepted', reviewedAt: reviewTimestamp(reviewedAt) },
    status: 'ready-for-review',
    approvedForSending: false,
  };
}

/** Records a human rejection without changing evidence verification or outreach state. */
export function rejectDiscoveredProfessorLead(candidate: ProfessorCandidate, reviewedAt = new Date().toISOString()): ProfessorCandidate {
  validatePendingProfessorLead(candidate);
  return {
    ...candidate,
    discoveryReview: { decision: 'rejected', reviewedAt: reviewTimestamp(reviewedAt) },
    approvedForSending: false,
  };
}
