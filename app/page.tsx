import Link from 'next/link';
import type { Metadata } from 'next';
import { ui } from '../src/web/ui-classes.ts';

export const metadata: Metadata = {
  title: { absolute: 'GradReach | Evidence-led graduate research' },
  description: 'GradReach helps its owner organize verified graduate research and review outreach safely.',
};

export default function WelcomePage() {
  return <main className={ui.shell}>
    <header className={`${ui.masthead} border-transparent`}>
      <Link className={ui.brand} href="/">GradReach <span className={ui.brandMark}>/</span></Link>
      <span className={ui.privateLabel}>Private research workspace</span>
    </header>
    <section className="grid min-w-0 items-center gap-10 py-12 sm:py-20 min-[851px]:grid-cols-[minmax(0,1.2fr)_minmax(260px,0.8fr)] min-[851px]:gap-16 min-[851px]:py-28">
      <div className="min-w-0">
        <p className={ui.eyebrow}>Research carefully. Reach out thoughtfully.</p>
        <h1 className="mt-4 max-w-3xl font-display text-[clamp(2.5rem,7vw,5.5rem)] font-bold leading-[1.02] tracking-[-0.055em] text-ink">A clearer path to your next research opportunity.</h1>
        <p className="mt-6 max-w-2xl text-base leading-7 text-muted sm:text-lg sm:leading-8">GradReach brings professor discovery, official-source evidence, program assessment, and reviewed outreach into one private workspace.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link className={ui.primaryButton} href="/workspace">Open my workspace</Link>
          <a className={ui.secondaryButton} href="#approach">See how it works</a>
        </div>
        <p className="mt-4 max-w-xl text-sm text-muted">The workspace is limited to its configured owner. Your research and applicant profile are not displayed on this public welcome page.</p>
      </div>
      <aside className={`${ui.panel} relative overflow-hidden p-6 sm:p-8`} aria-label="GradReach workflow overview">
        <div className="absolute -right-12 -top-12 size-40 rounded-full bg-green-soft" aria-hidden="true"/>
        <div className="relative">
          <p className={ui.eyebrow}>A careful workflow</p>
          <ol className="mt-6 grid gap-5">
            <li className="flex gap-4"><span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-green-soft font-mono text-sm font-semibold text-green">01</span><span><strong className="block text-ink">Find official sources</strong><span className="text-sm text-muted">Keep discovery scope and evidence visible.</span></span></li>
            <li className="flex gap-4"><span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-green-soft font-mono text-sm font-semibold text-green">02</span><span><strong className="block text-ink">Review before relying</strong><span className="text-sm text-muted">Separate recommendations from your decisions.</span></span></li>
            <li className="flex gap-4"><span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-green-soft font-mono text-sm font-semibold text-green">03</span><span><strong className="block text-ink">Approve each draft</strong><span className="text-sm text-muted">Email authorization and sending stay separate.</span></span></li>
          </ol>
        </div>
      </aside>
    </section>
    <section id="approach" className="grid min-w-0 gap-4 border-t border-line py-9 sm:grid-cols-3 sm:py-12">
      <article className="min-w-0"><p className={ui.eyebrow}>01 / Discover</p><h2 className="mt-2 font-display text-xl font-bold">Country-aware research</h2><p className="text-sm text-muted">Browse saved leads by discovery region and keep individual profiles distinct from general pages.</p></article>
      <article className="min-w-0"><p className={ui.eyebrow}>02 / Assess</p><h2 className="mt-2 font-display text-xl font-bold">Evidence before conclusions</h2><p className="text-sm text-muted">Review official program facts and keep unknown admissions or funding details explicit.</p></article>
      <article className="min-w-0"><p className={ui.eyebrow}>03 / Prepare</p><h2 className="mt-2 font-display text-xl font-bold">Human-approved outreach</h2><p className="text-sm text-muted">Drafts, approval, Gmail authorization, and any sending remain separate guarded steps.</p></article>
    </section>
    <footer className={`${ui.footer} flex flex-wrap items-center justify-between gap-3`}><span>GradReach · private owner workspace</span><Link className="font-semibold text-green underline-offset-4 hover:text-green-dark" href="/workspace">Open workspace</Link></footer>
  </main>;
}
