'use client';

import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { parseJobProgressEvent, type JobProgressEvent } from '../domain/job-progress.ts';

const stageLabels: Record<JobProgressEvent['stage'], string> = {
  starting: 'starting', searching: 'searching', fetching_pages: 'checking official pages',
  saving_candidates: 'saving eligible results', persisting_checks: 'saving evidence checks',
  delivering: 'processing an approved delivery', recording: 'recording delivery status',
  completed: 'complete', failed: 'stopped',
};

/** Displays transient progress only; refresh the workspace to read authoritative MongoDB records. */
export function JobProgressClient() {
  const [message, setMessage] = useState('');

  useEffect(() => {
    const socket = io({ path: '/api/socket.io', withCredentials: true });
    const onProgress = (value: unknown) => {
      try {
        const event = parseJobProgressEvent(value);
        const label = event.kind === 'discovery' ? 'Discovery' : 'Outreach';
        const counts = event.completed !== undefined && event.total !== undefined
          ? ` (${event.completed} of ${event.total})` : '';
        setMessage(`${label} ${stageLabels[event.stage]}${counts}. Refresh saved records for the latest details.`);
      } catch {
        // Ignore malformed events; the application never trusts socket payloads as records.
      }
    };
    socket.on('job:progress', onProgress);
    return () => { socket.off('job:progress', onProgress); socket.disconnect(); };
  }, []);

  return message ? <p className="sr-only" role="status" aria-live="polite">{message}</p> : null;
}
