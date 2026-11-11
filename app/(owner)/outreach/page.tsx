import type { Metadata } from 'next';
import { queueApprovedDraftsAction, recordOutcomeAction, togglePauseAction } from '../../actions.ts';
import { getOwnerWorkspace } from '../../../src/web/owner-data.ts';
import { ui } from '../../../src/web/ui-classes.ts';
import { getOutreachRuntimeStatus } from '../../../src/web/outreach-runtime-status.ts';

export const metadata: Metadata = { title: { absolute: 'GradReach | Outreach' } };

export default async function OutreachPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const [{ control, attempts, candidates }, query] = await Promise.all([getOwnerWorkspace(), searchParams]);
  const deliveryRuntime = getOutreachRuntimeStatus({
    sendingEnabled: process.env.OUTREACH_SENDING_ENABLED === 'true',
    control,
  });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Approval-gated delivery</p><h1 className={ui.pageTitle}>Outreach</h1><p className={ui.pageDescription}>Manage queue preparation and review the saved delivery history. Gmail authorization remains separate.</p></div><span className={`${ui.status} ${control.paused ? 'bg-amber-soft text-amber' : 'bg-green-soft text-green-dark'}`}>{control.paused ? 'Paused' : 'Active'}</span></div>
    {query.state === 'unavailable' ? <p className={ui.warning} role="status">Outreach control operation could not be completed. No sending was initiated by this website.</p> : query.state === 'saved' ? <p className={ui.note} role="status">Outreach queue settings updated.</p> : null}

    <section className={`${ui.grid} ${ui.section}`}>
      <article className={`${ui.panel} flex min-w-0 flex-col`}><p className={ui.eyebrow}>Queue controls</p><h2 className="mb-1 mt-2 font-display text-2xl font-bold">{control.paused ? 'Sending is paused' : 'Queue is active'}</h2><p className="mb-5 text-sm text-muted">Timezone: {control.timeZone}<br/>Daily limit: {control.dailyLimit} (maximum 5)</p><form action={togglePauseAction} className="mt-auto"><button className={control.paused ? ui.primaryButton : ui.dangerButton} type="submit">{control.paused ? 'Resume queue planning' : 'Pause queue planning'}</button></form></article>
      <article className={ui.panel}><p className={ui.eyebrow}>Delivery safeguards</p><h2 className="mb-2 mt-2 font-display text-xl font-bold">{deliveryRuntime.label}</h2><p className="text-sm text-muted">{deliveryRuntime.detail}</p><p className="mb-0 rounded-xl bg-paper p-3 text-sm font-medium">Website Google sign-in does not grant Gmail access. This page does not send email or inspect Gmail token status.</p></article>
      <article className={`${ui.panel} flex min-w-0 flex-col`}><p className={ui.eyebrow}>Queue preparation</p><h2 className="mb-2 mt-2 font-display text-xl font-bold">Plan approved drafts</h2><p className="mb-5 text-sm text-muted">Uses existing individual approvals, duplicate checks, source checks, and the configured daily cap. Planning records eligible items without sending.</p><form action={queueApprovedDraftsAction} className="mt-auto"><button className={ui.secondaryButton} type="submit">Prepare eligible queue</button></form></article>
    </section>

    <section className={ui.section}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><p className={ui.eyebrow}>Delivery audit</p><h2 className={`${ui.sectionTitle} mb-0 mt-1`}>Saved outreach attempts</h2></div><span className={ui.tag}>{attempts.length} records</span></div>
      {attempts.length ? <div className={ui.list}>{attempts.map((attempt, index) => {
        const candidate = byId.get(attempt.candidateId);
        return <article className={`${ui.panel} min-w-0`} key={`${attempt.candidateId}-${attempt.scheduledFor}-${index}`}>
          <div className={ui.cardTopline}><div className="min-w-0"><p className={ui.eyebrow}>Professor name</p><h3 className="mb-0 mt-1 break-words font-display text-lg font-bold">{candidate?.professorName?.trim() || 'Not established'}</h3>{candidate?.name ? <p className="mb-0 mt-1 break-words text-sm text-muted"><strong>Saved page title:</strong> {candidate.name}</p> : null}</div><span className={`${ui.status} ${attempt.state === 'sent' ? 'bg-green-soft text-green-dark' : ''}`}>{attempt.state}</span></div>
          <dl className="mt-4 grid min-w-0 grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-2"><div className="min-w-0"><dt className={ui.eyebrow}>Recipient</dt><dd className="mb-0 mt-1 break-all">{attempt.recipientEmail}</dd></div><div className="min-w-0"><dt className={ui.eyebrow}>Scheduled</dt><dd className="mb-0 mt-1 break-words">{attempt.scheduledFor}</dd></div>{attempt.sentAt ? <div><dt className={ui.eyebrow}>Sent at</dt><dd className="mb-0 mt-1 break-words">{attempt.sentAt}</dd></div> : null}{attempt.failureCode ? <div><dt className={ui.eyebrow}>Safe status</dt><dd className="mb-0 mt-1 break-words">{attempt.failureCode}</dd></div> : null}</dl>
          {attempt.state === 'sent' ? <form action={recordOutcomeAction} className={`${ui.formGrid} mt-5 border-t border-line pt-5`}><input type="hidden" name="candidateId" value={attempt.candidateId}/><label className={ui.formLabel}>Reply status<select className={ui.input} name="replyStatus" defaultValue={attempt.replyStatus ?? 'no-response'}><option value="replied">Replied</option><option value="no-response">No response</option><option value="declined">Declined</option></select></label><label className={ui.formLabel}>Follow-up status<select className={ui.input} name="followUpStatus" defaultValue={attempt.followUpStatus ?? 'not-planned'}><option value="not-planned">Not planned</option><option value="due">Due</option><option value="scheduled">Scheduled</option><option value="closed">Closed</option></select></label><label className={ui.formLabel}>Follow-up date and time<input className={ui.input} name="followUpScheduledFor" type="datetime-local" defaultValue={attempt.followUpScheduledFor?.slice(0, 16)} aria-describedby={`follow-up-help-${index}`}/><span id={`follow-up-help-${index}`} className={`${ui.muted} text-xs font-normal`}>Required when follow-up status is scheduled.</span></label><div className="flex items-end"><button className={ui.secondaryButton} type="submit">Save manual status</button></div></form> : null}
        </article>;
      })}</div> : <div className={`${ui.panel} ${ui.muted}`}>No outreach attempts are saved.</div>}
    </section>
  </main>;
}
