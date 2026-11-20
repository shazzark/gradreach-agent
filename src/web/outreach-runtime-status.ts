import type { SchedulerControl } from '../domain/outreach-queue.ts';
import { schedulerHeartbeatStatus, type SchedulerHeartbeat } from '../domain/scheduler-heartbeat.ts';

export type OutreachRuntimeState = 'disabled' | 'worker_down' | 'paused' | 'armed';

/** Formats a measured heartbeat age for owner-facing copy: seconds inside the stale window, minutes beyond it. */
function formatHeartbeatAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 120) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Reports the gates that must be open before the worker can deliver mail, plus whether that worker is actually running.
 * The worker heartbeat is evaluated after the sending gate because a disabled opt-in makes the worker exit on purpose,
 * and before the pause control because a dead supervisor is the more urgent problem — a paused queue with no worker
 * silently stops delivering the moment the owner resumes it.
 */
export function getOutreachRuntimeStatus(input: {
  sendingEnabled: boolean;
  control: Pick<SchedulerControl, 'paused'>;
  heartbeat?: SchedulerHeartbeat | undefined;
  now?: string;
}): { state: OutreachRuntimeState; label: string; detail: string } {
  if (!input.sendingEnabled) {
    return {
      state: 'disabled',
      label: 'Automatic Gmail delivery is disabled',
      detail: 'The server opt-in is off. The outreach worker exits without connecting to MongoDB.',
    };
  }
  const heartbeat = schedulerHeartbeatStatus(input.heartbeat, input.now ?? new Date().toISOString());
  if (heartbeat.state !== 'live') {
    return {
      state: 'worker_down',
      label: 'Worker is not running',
      detail: heartbeat.state === 'missing'
        ? 'No scheduler heartbeat has ever been recorded. Start the outreach worker process and check docs/phase-5-worker-supervision.md.'
        : `The last scheduler heartbeat was recorded ${formatHeartbeatAge(heartbeat.ageMs ?? 0)} ago, so the worker loop has stopped. Start the outreach worker process and check docs/phase-5-worker-supervision.md.`,
    };
  }
  if (input.control.paused) {
    return {
      state: 'paused',
      label: 'Automatic Gmail delivery is paused',
      detail: 'The server opt-in is on, but the saved pause control prevents delivery.',
    };
  }
  return {
    state: 'armed',
    label: 'Automatic Gmail delivery is enabled and unpaused',
    detail: `The outreach worker checked in ${formatHeartbeatAge(heartbeat.ageMs ?? 0)} ago, so it can send eligible queued drafts.`,
  };
}
