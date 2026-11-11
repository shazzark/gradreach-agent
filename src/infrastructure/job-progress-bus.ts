import { parseJobProgressEvent, type JobProgressEvent } from '../domain/job-progress.ts';

type ProgressListener = (event: JobProgressEvent) => void;
interface ProgressBus { listeners: Set<ProgressListener> }
const busKey = Symbol.for('gradreach.job-progress-bus');

function getBus(): ProgressBus {
  const root = globalThis as typeof globalThis & { [key: symbol]: ProgressBus | undefined };
  return root[busKey] ??= { listeners: new Set() };
}

/** Publishes an allowlisted transient event; callers must persist records before publishing. */
export function publishJobProgress(value: JobProgressEvent): void {
  const event = parseJobProgressEvent(value);
  for (const listener of getBus().listeners) {
    try { listener(event); } catch { /* A progress observer must not change the job outcome. */ }
  }
}

export function subscribeToJobProgress(listener: ProgressListener): () => void {
  const listeners = getBus().listeners;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
