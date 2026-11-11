export const JOB_PROGRESS_STAGES = [
  'starting', 'searching', 'fetching_pages', 'saving_candidates', 'persisting_checks',
  'delivering', 'recording', 'completed', 'failed',
] as const;

export type JobProgressStage = typeof JOB_PROGRESS_STAGES[number];
export type JobProgressKind = 'discovery' | 'outreach';
export type JobProgressState = 'running' | 'completed' | 'failed';

/** A transient notification only. Persisted job and lead records remain authoritative in MongoDB. */
export interface JobProgressEvent {
  jobId: string;
  kind: JobProgressKind;
  state: JobProgressState;
  stage: JobProgressStage;
  completed?: number;
  total?: number;
  updatedAt: string;
}

const allowedKeys = new Set(['jobId', 'kind', 'state', 'stage', 'completed', 'total', 'updatedAt']);

export function parseJobProgressEvent(value: unknown): JobProgressEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid job progress event');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error('Unsupported job progress field');
  if (typeof input.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.jobId)) throw new Error('Invalid job progress ID');
  if (input.kind !== 'discovery' && input.kind !== 'outreach') throw new Error('Invalid job progress kind');
  if (input.state !== 'running' && input.state !== 'completed' && input.state !== 'failed') throw new Error('Invalid job progress state');
  if (typeof input.stage !== 'string' || !JOB_PROGRESS_STAGES.includes(input.stage as JobProgressStage)) throw new Error('Invalid job progress stage');
  if (typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))) throw new Error('Invalid job progress timestamp');
  for (const field of ['completed', 'total'] as const) {
    if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || (input[field] as number) < 0)) {
      throw new Error('Invalid job progress count');
    }
  }
  if (input.completed !== undefined && input.total !== undefined && (input.completed as number) > (input.total as number)) {
    throw new Error('Job progress exceeds its total');
  }
  return {
    jobId: input.jobId,
    kind: input.kind,
    state: input.state,
    stage: input.stage as JobProgressStage,
    ...(input.completed !== undefined ? { completed: input.completed as number } : {}),
    ...(input.total !== undefined ? { total: input.total as number } : {}),
    updatedAt: input.updatedAt,
  };
}
