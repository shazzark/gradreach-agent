import type { OutreachAttempt, ProfessorCandidate, QueueSelection, SchedulerControl } from '../domain/outreach-queue.ts';
import { getLocalDateKey, selectDailyOutreachBatch } from '../domain/outreach-queue.ts';

export interface DailyOutreachPlan {
  selection: QueueSelection;
  attemptsToQueue: OutreachAttempt[];
  paused: boolean;
}

/** Prepares queue records only; this module has no email provider or send capability. */
export function planDailyOutreach(input: {
  control: SchedulerControl;
  candidates: ProfessorCandidate[];
  attempts: OutreachAttempt[];
  now: string;
}): DailyOutreachPlan {
  if (!Number.isInteger(input.control.dailyLimit) || input.control.dailyLimit < 1 || input.control.dailyLimit > 5) {
    throw new Error('dailyLimit must be an integer from 1 to 5');
  }
  const dateKey = getLocalDateKey(input.now, input.control.timeZone);
  if (input.control.paused) {
    return {
      paused: true,
      selection: {
        dateKey,
        limit: input.control.dailyLimit,
        remainingCapacity: input.control.dailyLimit,
        selected: [],
        skipped: input.candidates.map((candidate) => ({ candidateId: candidate.id, reason: 'scheduler is paused' })),
      },
      attemptsToQueue: [],
    };
  }
  const selection = selectDailyOutreachBatch({
    candidates: input.candidates,
    attempts: input.attempts,
    now: input.now,
    timeZone: input.control.timeZone,
    dailyLimit: input.control.dailyLimit,
  });
  const scheduledFor = new Date(input.now).toISOString();
  return {
    paused: false,
    selection,
    attemptsToQueue: selection.selected.map((candidate) => ({
      candidateId: candidate.id,
      recipientEmail: candidate.officialEmail!,
      scheduledFor,
      state: 'queued',
    })),
  };
}
