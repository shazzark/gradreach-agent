import type { Metadata } from 'next';
import { importProgramAction, reassessProgramAction } from '../../actions.ts';
import { getOwnerWorkspace } from '../../../src/web/owner-data.ts';
import { previewSavedExcerpt } from '../../../src/web/lead-card-view.ts';
import { safeOfficialSourceUrl } from '../../../src/web/safe-source-url.ts';
import { ui } from '../../../src/web/ui-classes.ts';

export const metadata: Metadata = { title: { absolute: 'GradReach | Programs' } };

const facts = ['admissions', 'english', 'tuition', 'funding', 'intake', 'deadline'] as const;

export default async function ProgramsPage({ searchParams }: { searchParams: Promise<{ country?: string; outcome?: string; q?: string; state?: string }> }) {
  const [{ programs, assessments }, query] = await Promise.all([getOwnerWorkspace(), searchParams]);
  const latest = new Map(assessments.map((assessment) => [assessment.programId, assessment]));
  const countries = [...new Set(programs.map((program) => program.country).filter(Boolean))].sort();
  const outcomes = [...new Set(assessments.map((assessment) => assessment.overall))].sort();
  const search = query.q?.trim().toLocaleLowerCase('en') ?? '';
  const visiblePrograms = programs.filter((program) => {
    const outcome = latest.get(program.id)?.overall ?? 'not assessed';
    return (!query.country || program.country === query.country) && (!query.outcome || outcome === query.outcome) &&
      (!search || `${program.name} ${program.institution}`.toLocaleLowerCase('en').includes(search));
  });
  return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Evidence-led comparison</p><h1 className={ui.pageTitle}>Programs</h1><p className={ui.pageDescription}>Review saved program records and their official-source assessment evidence.</p></div><span className={ui.tag}>{programs.length} saved {programs.length === 1 ? 'program' : 'programs'}</span></div>
    {query.state === 'unavailable' ? <p className={ui.warning} role="status">Program operation was not completed. Check the record's source fields and server configuration.</p> : query.state === 'saved' ? <p className={ui.note} role="status">Program record saved and assessed.</p> : null}

    <section className={`${ui.panel} ${ui.section}`}>
      <div className="mb-4"><p className={ui.eyebrow}>Browse records</p><h2 className={`${ui.sectionTitle} mb-0 mt-1`}>Find a program</h2></div>
      <form method="get" action="/programs" className="grid min-w-0 grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className={ui.formLabel}>Institution or program<input className={ui.input} name="q" defaultValue={query.q ?? ''} maxLength={200}/></label>
        <label className={ui.formLabel}>Country<select className={ui.input} name="country" defaultValue={query.country ?? ''}><option value="">All countries</option>{countries.map((country) => <option key={country}>{country}</option>)}</select></label>
        <label className={ui.formLabel}>Assessment outcome<select className={ui.input} name="outcome" defaultValue={query.outcome ?? ''}><option value="">All outcomes</option>{outcomes.map((outcome) => <option key={outcome}>{outcome}</option>)}<option value="not assessed">Not assessed</option></select></label>
        <button className={ui.primaryButton} type="submit">Apply filters</button>
      </form>
    </section>

    <section className={ui.section}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2"><h2 className={ui.sectionTitle}>Saved programs</h2><span className={ui.eyebrow}>{visiblePrograms.length} matching records</span></div>
      {visiblePrograms.length ? <div className={ui.list}>{visiblePrograms.map((program) => {
        const result = latest.get(program.id);
        const outcome = result?.overall ?? 'not assessed';
        return <article className={`${ui.panel} min-w-0`} key={program.id}>
          <div className={ui.cardTopline}><div className="min-w-0"><p className={ui.eyebrow}>{program.institution}</p><h3 className="mb-0 mt-1 break-words font-display text-lg font-bold">{program.name}</h3></div><span className={`${ui.status} ${outcome === 'eligible' ? 'bg-green-soft text-green-dark' : outcome === 'ineligible' ? 'bg-red/10 text-red' : ''}`}>{outcome}</span></div>
          <p className="mb-0 mt-3 break-words text-sm text-muted">{program.country} <span aria-hidden="true">·</span> Intake {program.intake}</p>
          {result ? <details className="mt-4 rounded-xl border border-line bg-paper px-4"><summary className="min-h-11 cursor-pointer py-2.5 text-sm font-semibold">Assessment reasons and source evidence</summary><div className="grid min-w-0 grid-cols-1 gap-3 pb-4 sm:grid-cols-2 xl:grid-cols-3">{facts.map((field) => <section className="min-w-0 rounded-xl border border-line bg-white p-3.5" key={field}><h4 className="mb-2 mt-0 break-words font-display text-sm font-bold capitalize">{field} <span className="font-mono text-xs font-medium text-muted">· {result[field].outcome}</span></h4><ul className="my-2 list-disc space-y-1 pl-5 text-sm text-muted">{result[field].reasons.map((reason, index) => <li className="break-words" key={index}>{reason}</li>)}</ul>{result[field].evidence.map((item, index) => { const href = safeOfficialSourceUrl(item.sourceUrl); return <div className="mt-3 border-t border-line pt-3 text-sm" key={index}>{href ? <a className="break-all font-semibold text-green underline underline-offset-4" href={href} target="_blank" rel="noopener noreferrer">{href}</a> : <span className="text-muted">Official source unavailable</span>}<p className="mb-1 mt-2 break-words text-muted">Checked {item.checkedAt.slice(0, 10)}</p><p className="mb-0 break-words">{previewSavedExcerpt(item.excerpt)}</p>{item.excerpt.length > 260 ? <details className="mt-2"><summary className="min-h-11 cursor-pointer py-2 text-xs font-semibold">Show full saved excerpt</summary><p className="break-words">{item.excerpt}</p></details> : null}</div>; })}</section>)}</div></details> : <p className="mb-0 mt-4 rounded-xl bg-paper p-3 text-sm text-muted">No assessment is saved for this program yet.</p>}
          <div className="mt-4 border-t border-line pt-4"><form action={reassessProgramAction}><input type="hidden" name="programId" value={program.id}/><button className={ui.secondaryButton} type="submit">Reassess against current profile</button></form></div>
        </article>;
      })}</div> : <p className={`${ui.panel} ${ui.muted}`}>{programs.length ? 'No saved programs match these filters.' : 'No program records are saved yet.'}</p>}
    </section>

    <details className={`${ui.panel} ${ui.section}`}><summary className="min-h-11 cursor-pointer py-1 font-display text-lg font-bold">Add a reviewed program record</summary><p className="mb-4 mt-3 text-sm text-muted">Use GradReach’s existing record format. Every claim needs reviewed official HTTPS evidence and a check date.</p><form action={importProgramAction} className={ui.stack}><label className={ui.formLabel}>Program record JSON<textarea className={ui.textarea} name="programJson" maxLength={100000} required placeholder={'{"id":"...","institution":"...","name":"...","country":"...","intake":"..."}'}/></label><button className={`${ui.primaryButton} justify-self-start`} type="submit">Validate, save and assess</button></form></details>
  </main>;
}
