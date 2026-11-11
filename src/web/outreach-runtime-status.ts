import type { SchedulerControl } from '../domain/outreach-queue.ts';

export type OutreachRuntimeState = 'disabled' | 'paused' | 'armed';

/** Reports the two independent gates that must be open before the worker can deliver mail. */
export function getOutreachRuntimeStatus(input: {
  sendingEnabled: boolean;
  control: Pick<SchedulerControl, 'paused'>;
}): { state: OutreachRuntimeState; label: string; detail: string } {
  if (!input.sendingEnabled) {
    return {
      state: 'disabled',
      label: 'Automatic Gmail delivery is disabled',
      detail: 'The server opt-in is off. The outreach worker exits without connecting to MongoDB.',
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
    detail: 'If the separate outreach worker is running, it can send eligible queued drafts.',
  };
}
