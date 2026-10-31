import Link from 'next/link';
import { getOwnerWorkspace } from '../../src/web/owner-data.ts';

export default async function OverviewPage() {
  const { dashboard, control } = await getOwnerWorkspace();
  const percent = Math.min(100, Math.round((dashboard.candidates / dashboard.targetPoolSize) * 100));
  return <main>
    <div className="page-head"><div><p className="eyebrow">Private workspace · progress</p><h1>Research overview</h1><p>Saved source-backed work and outreach safeguards at a glance.</p></div><span className="status">Outreach {control.paused ? 'paused' : 'active'}</span></div>
    <section className="grid">
      <article className="stat"><div className="value">{dashboard.candidates}<span className="muted"> / {dashboard.targetPoolSize}</span></div><div className="label">Saved discovery leads</div><div className="progress section"><span style={{ width: `${percent}%` }}/></div><Link href="/leads">Review leads →</Link></article>
      <article className="stat"><div className="value">{dashboard.profilesReviewed}</div><div className="label">Profiles with reviewed evidence</div><div className="hint">{dashboard.needsEvidence} still need evidence review</div></article>
      <article className="stat"><div className="value">{dashboard.readyForReview}</div><div className="label">Ready for draft review</div><div className="hint">{dashboard.approved} explicitly approved for sending</div></article>
      <article className="stat"><div className="value">{dashboard.programs}</div><div className="label">Saved programs</div><Link href="/programs">Assess programs →</Link></article>
      <article className="stat"><div className="value">{dashboard.assessments.eligible} / {dashboard.assessments.unclear} / {dashboard.assessments.ineligible}</div><div className="label">Assessments: eligible / unclear / ineligible</div></article>
      <article className="stat"><div className="value">{dashboard.queuedToday} / {dashboard.sentToday}</div><div className="label">Queued / sent today ({control.timeZone})</div><div className="hint">{dashboard.dailyCapacityRemaining} daily slots remain · max 5</div></article>
    </section>
    <section className="panel section"><h2 className="section-title">Next steps</h2><div className="actions"><Link className="button" href="/leads">Review professor evidence</Link><Link className="button secondary" href="/programs">Review program facts</Link><Link className="button secondary" href="/drafts">Review drafts</Link><Link className="button secondary" href="/outreach">Manage queue</Link></div><p className="muted">Google website sign-in does not authorize Gmail. A draft must be explicitly reviewed and approved; sending remains separately disabled unless configured.</p></section>
  </main>;
}
