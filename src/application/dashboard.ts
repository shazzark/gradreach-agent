import { getLocalDateKey, type OutreachAttempt, type ProfessorCandidate, type SchedulerControl } from '../domain/outreach-queue.ts';
import type { ProgramAssessment, ProgramRecord } from '../domain/program-assessment.ts';
import { planDailyOutreach } from './daily-outreach-planner.ts';

export interface DashboardSnapshot {
  targetPoolSize: number;
  candidates: number;
  profilesReviewed: number;
  needsEvidence: number;
  readyForReview: number;
  approved: number;
  programs: number;
  assessments: Record<'eligible' | 'unclear' | 'ineligible', number>;
  queuedToday: number;
  sentToday: number;
  dailyCapacityRemaining: number;
  paused: boolean;
  proposedCandidateIds: string[];
}

export function buildDashboardSnapshot(input: {
  candidates: ProfessorCandidate[];
  programs: ProgramRecord[];
  assessments: ProgramAssessment[];
  attempts: OutreachAttempt[];
  control: SchedulerControl;
  now: string;
  targetPoolSize?: number;
}): DashboardSnapshot {
  const plan = planDailyOutreach({ control: input.control, candidates: input.candidates, attempts: input.attempts, now: input.now });
  const dateAttempts = input.attempts.filter((attempt) => attempt.state !== 'cancelled' &&
    getLocalDateKey(attempt.scheduledFor, input.control.timeZone) === plan.selection.dateKey);
  return {
    targetPoolSize: input.targetPoolSize ?? 200,
    candidates: input.candidates.length,
    profilesReviewed: input.candidates.filter((candidate) => candidate.discoveryEvidence?.some((item) => item.kind === 'professor-profile' && item.verification === 'reviewed')).length,
    needsEvidence: input.candidates.filter((candidate) => candidate.status === 'needs-evidence').length,
    readyForReview: input.candidates.filter((candidate) => candidate.status === 'ready-for-review').length,
    approved: input.candidates.filter((candidate) => candidate.status === 'approved' && candidate.approvedForSending).length,
    programs: input.programs.length,
    assessments: {
      eligible: input.assessments.filter((assessment) => assessment.overall === 'eligible').length,
      unclear: input.assessments.filter((assessment) => assessment.overall === 'unclear').length,
      ineligible: input.assessments.filter((assessment) => assessment.overall === 'ineligible').length,
    },
    queuedToday: dateAttempts.filter((attempt) => attempt.state === 'queued').length,
    sentToday: dateAttempts.filter((attempt) => attempt.state === 'sent').length,
    dailyCapacityRemaining: plan.selection.remainingCapacity,
    paused: input.control.paused,
    proposedCandidateIds: plan.selection.selected.map((candidate) => candidate.id),
  };
}

function csvCell(value: string): string {
  const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Exports source and review metadata while neutralizing spreadsheet formula prefixes. */
export function candidatesToCsv(candidates: ProfessorCandidate[]): string {
  const columns: Array<[string, (candidate: ProfessorCandidate) => string]> = [
    ['id', (item) => item.id], ['name', (item) => item.name], ['institution', (item) => item.institution],
    ['country', (item) => item.country], ['status', (item) => item.status], ['priority', (item) => String(item.priority)],
    ['official_email', (item) => item.officialEmail ?? ''], ['profile_url', (item) => item.officialProfileUrl ?? ''],
    ['contact_url', (item) => item.officialContactUrl ?? ''], ['program_url', (item) => item.programUrl ?? ''],
    ['source_checked_at', (item) => item.sourceCheckedAt ?? ''],
  ];
  return [columns.map(([name]) => csvCell(name)).join(','), ...candidates.map((item) => columns.map(([, value]) => csvCell(value(item))).join(','))].join('\r\n');
}
