'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { io } from 'socket.io-client';
import { createJobProgressHandler, type JobProgressEvent } from '../domain/job-progress.ts';

const stageLabels: Record<JobProgressEvent['stage'], string> = {
  starting: 'starting', searching: 'searching', fetching_pages: 'checking official pages',
  saving_candidates: 'saving eligible results', persisting_checks: 'saving evidence checks',
  delivering: 'processing an approved delivery', recording: 'recording delivery status',
  completed: 'complete', failed: 'stopped',
};

/** Displays transient progress only; refresh the workspace to read authoritative MongoDB records. */
export function JobProgressClient() {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = io({ path: '/api/socket.io', withCredentials: true });
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), 200);
    };
    const onProgress = createJobProgressHandler((event) => {
        const label = event.kind === 'discovery' ? 'Discovery' : event.kind === 'outreach' ? 'Outreach' : 'Workspace';
        const counts = event.completed !== undefined && event.total !== undefined
          ? ` (${event.completed} of ${event.total})` : '';
        setMessage(`${label} ${stageLabels[event.stage]}${counts}. Saved workspace data is updating.`);
        refreshSoon();
    });
    const onConnect = () => { setConnected(true); refreshSoon(); };
    const onDisconnect = () => setConnected(false);
    const fallback = setInterval(() => router.refresh(), 30_000);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('job:progress', onProgress);
    return () => {
      clearInterval(fallback);
      if (refreshTimer) clearTimeout(refreshTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('job:progress', onProgress);
      socket.disconnect();
    };
  }, [router]);

  return <>
    <p className="sr-only" role="status" aria-live="polite">{message}</p>
    <p className="fixed bottom-2 right-2 z-50 rounded-md border border-line bg-white/90 px-2 py-1 font-mono text-[10px] text-muted" role="status" aria-label={connected ? 'Live updates connected; data refreshes periodically' : 'Live updates reconnecting; data refreshes periodically'}>
      {connected ? 'Live updates' : 'Refreshing'}
    </p>
  </>;
}
