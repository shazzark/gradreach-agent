import Link from 'next/link';
import type { Metadata } from 'next';
import { getOwnerWorkspace } from '../../../src/web/owner-data.ts';
import { ui } from '../../../src/web/ui-classes.ts';

export const metadata: Metadata = { title: { absolute: 'GradReach | Workspace' } };

export default async function OverviewPage() {
  const { dashboard, control, profile, profileSetupRequired } = await getOwnerWorkspace();
  if (profileSetupRequired) return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Workspace setup</p><h1 className={ui.pageTitle}>Start with your profile</h1><p className={ui.pageDescription}>Add known details to tailor research and assessments. Optional contact, test, and document fields can stay blank.</p></div></div>
    <section className={`${ui.panel} flex flex-col items-start gap-4 sm:p-8`}><span className={`${ui.tag} border-amber/20 bg-amber-soft text-amber`}>Profile setup needed</span><div><h2 className="m-0 font-display text-xl font-bold">No complete applicant profile is saved</h2><p className="mb-0 mt-2 max-w-2xl text-sm text-muted">Open profile settings to add or edit the details you know. Nothing is filled with sample applicant values.</p></div><Link className={ui.primaryButton} href="/profile">Set up profile</Link></section>
  </main>;

  const percent = Math.min(100, Math.round((dashboard.candidates / dashboard.targetPoolSize) * 100));
  const metrics = [
    { label: 'Saved discovery leads', value: dashboard.candidates, detail: `of the ${dashboard.targetPoolSize} lead research goal`, href: '/leads', action: 'Review leads' },
    { label: 'Profiles reviewed', value: dashboard.profilesReviewed, detail: `${dashboard.needsEvidence} still need evidence review`, href: '/leads', action: 'Review evidence' },
    { label: 'Drafts ready for review', value: dashboard.readyForReview, detail: `${dashboard.approved} approved for the queue`, href: '/drafts', action: 'Review drafts' },
    { label: 'Saved programs', value: dashboard.programs, detail: `${dashboard.assessments.eligible} eligible assessments`, href: '/programs', action: 'Assess programs' },
  ];
  return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Research workspace</p><h1 className={ui.pageTitle}>Overview</h1><p className={ui.pageDescription}>Your saved research, assessment progress, and outreach controls.</p></div><span className={`${ui.status} ${control.paused ? 'bg-amber-soft text-amber' : 'bg-green-soft text-green-dark'}`}>{control.paused ? 'Outreach paused' : 'Outreach active'}</span></div>

    <section className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workspace progress">
      {metrics.map((metric, index) => <article className={ui.stat} key={metric.label}>
        <p className={ui.eyebrow}>{metric.label}</p><p className="mb-0 mt-2 font-display text-4xl font-bold tracking-tight text-ink">{metric.value}</p><p className="mb-4 mt-1 text-sm text-muted">{metric.detail}</p>
        {index === 0 ? <div className="mb-4" role="progressbar" aria-label="Saved leads toward research goal" aria-valuemin={0} aria-valuemax={dashboard.targetPoolSize} aria-valuenow={Math.min(dashboard.candidates, dashboard.targetPoolSize)}><div className={ui.progress}><span className={ui.progressFill} style={{ width: `${percent}%` }}/></div></div> : null}
        <Link className="text-sm font-semibold text-green underline-offset-4 hover:text-green-dark" href={metric.href}>{metric.action} <span aria-hidden="true">→</span></Link>
      </article>)}
    </section>

    <section className={`${ui.grid} ${ui.section}`}>
      <article className={`${ui.panel} sm:col-span-2`}><div className={ui.cardTopline}><div><p className={ui.eyebrow}>Assessment outcomes</p><h2 className={`${ui.sectionTitle} mb-0 mt-1`}>Program review</h2></div><Link className="text-sm font-semibold text-green" href="/programs">Open programs →</Link></div><div className="mt-5 grid grid-cols-1 gap-3 min-[430px]:grid-cols-3">{[['Eligible', dashboard.assessments.eligible], ['Unclear', dashboard.assessments.unclear], ['Ineligible', dashboard.assessments.ineligible]].map(([label, value]) => <div className="rounded-xl border border-line bg-paper p-4" key={label}><p className={ui.eyebrow}>{label}</p><p className="mb-0 mt-1 font-display text-2xl font-bold">{value}</p></div>)}</div></article>
      <article className={`${ui.panel} sm:col-span-2`}><div className={ui.cardTopline}><div><p className={ui.eyebrow}>Outreach activity</p><h2 className={`${ui.sectionTitle} mb-0 mt-1`}>Daily queue</h2></div><Link className="text-sm font-semibold text-green" href="/outreach">Manage queue →</Link></div><div className="mt-5 grid grid-cols-1 gap-3 min-[430px]:grid-cols-3"><div className="rounded-xl border border-line bg-paper p-4"><p className={ui.eyebrow}>Queued today</p><p className="mb-0 mt-1 font-display text-2xl font-bold">{dashboard.queuedToday}</p></div><div className="rounded-xl border border-line bg-paper p-4"><p className={ui.eyebrow}>Sent today</p><p className="mb-0 mt-1 font-display text-2xl font-bold">{dashboard.sentToday}</p></div><div className="rounded-xl border border-line bg-paper p-4"><p className={ui.eyebrow}>Capacity left</p><p className="mb-0 mt-1 font-display text-2xl font-bold">{dashboard.dailyCapacityRemaining}<span className="ml-1 text-sm font-medium text-muted">/ {control.dailyLimit}</span></p></div></div><p className="mb-0 mt-3 text-xs text-muted">Daily totals use {control.timeZone}. The system enforces a maximum of five sends per day.</p></article>
    </section>

    <section className={`${ui.panel} ${ui.section}`}><div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.65fr)] lg:items-center"><div><p className={ui.eyebrow}>Configured research scope</p><h2 className={`${ui.sectionTitle} mb-2 mt-1`}>Countries from your saved profile</h2>{profile.applicant.target.countries.length ? <ul className="m-0 flex list-none flex-wrap gap-2 p-0">{profile.applicant.target.countries.map((country) => <li className={ui.tag} key={country}>{country}</li>)}</ul> : <p className="mb-0 text-sm text-muted">No countries are configured yet.</p>}</div><div className="flex flex-wrap gap-2 lg:justify-end"><Link className={ui.secondaryButton} href="/profile">Edit profile settings</Link><Link className={ui.primaryButton} href="/leads">Browse leads</Link></div></div></section>

    <p className="mb-8 max-w-3xl text-xs leading-5 text-muted">Website sign-in is separate from Gmail authorization. Drafts need individual approval, and daily sending remains limited by the existing scheduler safeguards.</p>
  </main>;
}
