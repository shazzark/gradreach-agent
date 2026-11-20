import type { SchedulerWorker } from '../domain/scheduler-heartbeat.ts';

/** The narrow storage surface a worker needs in order to prove it is alive. */
export interface SchedulerHeartbeatWriter {
  updateSchedulerHeartbeat(worker: SchedulerWorker, lastHeartbeatAt?: string): Promise<void>;
}

/**
 * Records one worker heartbeat. Supervision is diagnostic, so a storage failure is reported and swallowed: crashing the
 * delivery loop because its own heartbeat write failed would be worse than the website showing a stale worker.
 */
export async function pulseSchedulerHeartbeat(
  heartbeat: SchedulerHeartbeatWriter,
  worker: SchedulerWorker,
  now = new Date(),
): Promise<boolean> {
  try {
    await heartbeat.updateSchedulerHeartbeat(worker, now.toISOString());
    return true;
  } catch {
    process.stderr.write(`The ${worker} scheduler heartbeat could not be recorded. The worker keeps running, so the website may report it as stopped until a write succeeds.\n`);
    return false;
  }
}
