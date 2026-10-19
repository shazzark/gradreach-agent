export type CandidateStatus =
  | 'researching'
  | 'needs-evidence'
  | 'ready-for-review'
  | 'approved'
  | 'sent'
  | 'replied'
  | 'closed';

export interface ProfessorCandidate {
  id: string;
  name: string;
  institution: string;
  country: string;
  officialProfileUrl?: string;
  officialEmail?: string;
  emailSourceUrl?: string;
  programUrl?: string;
  fundingSourceUrl?: string;
  eligibilitySourceUrl?: string;
  sourceCheckedAt?: string;
  fitSummary?: string;
  personalizedDraft?: string;
  status: CandidateStatus;
  approvedForSending: boolean;
  priority: number;
}

export interface OutreachAttempt {
  candidateId: string;
  recipientEmail: string;
  scheduledFor: string;
  state: 'queued' | 'sent' | 'cancelled';
}

export interface QueueSelection {
  dateKey: string;
  limit: number;
  remainingCapacity: number;
  selected: ProfessorCandidate[];
  skipped: Array<{ candidateId: string; reason: string }>;
}

const REQUIRED_EVIDENCE: Array<keyof ProfessorCandidate> = [
  'officialProfileUrl',
  'emailSourceUrl',
  'programUrl',
  'sourceCheckedAt',
  'fitSummary',
  'personalizedDraft',
];

function hasValidEmail(value: string | undefined): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function hasSecureUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function candidateReadinessIssue(candidate: ProfessorCandidate): string | undefined {
  if (!candidate.approvedForSending || candidate.status !== 'approved') {
    return 'not approved for sending';
  }
  if (!hasValidEmail(candidate.officialEmail)) return 'missing a valid email address';
  for (const field of REQUIRED_EVIDENCE) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `missing ${field}`;
    }
  }
  for (const field of ['officialProfileUrl', 'emailSourceUrl', 'programUrl'] as const) {
    if (!hasSecureUrl(candidate[field])) return `${field} must be an HTTPS source`;
  }
  return undefined;
}

function dateKeyFor(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new Error(`Could not calculate local date in ${timeZone}`);
  return `${year}-${month}-${day}`;
}

/** Selects a safe, evidence-complete set for a local calendar day. This does not send email. */
export function selectDailyOutreachBatch(input: {
  candidates: ProfessorCandidate[];
  attempts: OutreachAttempt[];
  now: string;
  timeZone: string;
  dailyLimit?: number;
}): QueueSelection {
  const limit = input.dailyLimit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error('dailyLimit must be an integer from 1 to 5');
  }
  const dateKey = dateKeyFor(input.now, input.timeZone);
  const countedAttempts = input.attempts.filter((attempt) =>
    attempt.state !== 'cancelled' && dateKeyFor(attempt.scheduledFor, input.timeZone) === dateKey,
  );
  const remainingCapacity = Math.max(0, limit - countedAttempts.length);
  const priorIds = new Set(input.attempts.filter((attempt) => attempt.state !== 'cancelled').map((attempt) => attempt.candidateId));
  const priorEmails = new Set(input.attempts.filter((attempt) => attempt.state !== 'cancelled').map((attempt) => attempt.recipientEmail.trim().toLowerCase()));
  const seenEmails = new Set<string>();
  const skipped: QueueSelection['skipped'] = [];
  const ready: ProfessorCandidate[] = [];

  for (const candidate of [...input.candidates].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))) {
    const issue = candidateReadinessIssue(candidate);
    if (issue) {
      skipped.push({ candidateId: candidate.id, reason: issue });
      continue;
    }
    const email = candidate.officialEmail!.trim().toLowerCase();
    if (priorIds.has(candidate.id) || priorEmails.has(email) || seenEmails.has(email)) {
      skipped.push({ candidateId: candidate.id, reason: 'duplicate or previously contacted' });
      continue;
    }
    seenEmails.add(email);
    ready.push(candidate);
  }

  const selected = ready.slice(0, remainingCapacity);
  for (const candidate of ready.slice(remainingCapacity)) {
    skipped.push({ candidateId: candidate.id, reason: 'daily limit reached' });
  }
  return { dateKey, limit, remainingCapacity, selected, skipped };
}

/** Returns YYYY-MM-DD for the given instant in the applicant's configured timezone. */
export function getLocalDateKey(instant: string, timeZone: string): string {
  return dateKeyFor(instant, timeZone);
}
