/**
 * Whether a supervised worker is still polling, expressed as time rather than as process state. Both workers tick every
 * 60 seconds, so a record older than two minutes means the loop stopped — crashed process, closed terminal, or a
 * supervisor that never restarted it — even while the website itself stays up and looks healthy.
 */
export const SCHEDULER_HEARTBEAT_STALE_MS = 120_000;

export const SCHEDULER_WORKERS = ['outreach', 'discovery'] as const;
export type SchedulerWorker = (typeof SCHEDULER_WORKERS)[number];

/** The persisted shape: one document per worker, carrying only the instant of its last completed tick. */
export interface SchedulerHeartbeat {
  lastHeartbeatAt: string;
}

export type SchedulerHeartbeatState = 'live' | 'stale' | 'missing';

export interface SchedulerHeartbeatStatus {
  state: SchedulerHeartbeatState;
  /** Time since the last heartbeat, floored at zero so a skewed clock cannot report a negative age. */
  ageMs?: number;
  lastHeartbeatAt?: string;
}

export function isSchedulerWorker(value: string): value is SchedulerWorker {
  return (SCHEDULER_WORKERS as readonly string[]).includes(value);
}

/**
 * Classifies a stored heartbeat for the owner-facing status surfaces. A worker that never checked in is `missing`, not
 * `live`: a fresh deployment that never started its worker must not look supervised.
 */
export function schedulerHeartbeatStatus(heartbeat: SchedulerHeartbeat | undefined, now: string | Date): SchedulerHeartbeatStatus {
  const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('now must be a valid date');
  const storedMs = heartbeat ? Date.parse(heartbeat.lastHeartbeatAt) : Number.NaN;
  if (!Number.isFinite(storedMs)) return { state: 'missing' };
  const ageMs = Math.max(0, nowMs - storedMs);
  const lastHeartbeatAt = new Date(storedMs).toISOString();
  return ageMs > SCHEDULER_HEARTBEAT_STALE_MS
    ? { state: 'stale', ageMs, lastHeartbeatAt }
    : { state: 'live', ageMs, lastHeartbeatAt };
}
