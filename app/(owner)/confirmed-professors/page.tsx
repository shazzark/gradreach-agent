import type { Metadata } from 'next';
import { loadConfirmedProfessorPreviewData } from '../../../src/web/confirmed-professors-data.ts';
import { withOwnerData } from '../../../src/web/owner-data.ts';
import { ui } from '../../../src/web/ui-classes.ts';
import type { ConfirmedResearchStatus } from '../../../src/application/confirmed-professors.ts';

export const metadata: Metadata = { title: { absolute: 'GradReach | Confirmed professors' } };

function ResearchStatus({ status }: { status: ConfirmedResearchStatus }) {
  const label = status === 'matched' ? 'Matched' : status === 'evidence_found_but_not_matched' ? 'Evidence found, not matched' : status === 'no_research_evidence' ? 'No research evidence' : 'Not evaluated';
  const style = status === 'matched' ? 'border-green/20 bg-green-soft text-green-dark' : 'border-line bg-paper text-slate-700';
  return <span className={`inline-flex max-w-full rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide ${style}`}>{label}</span>;
}

export default async function ConfirmedProfessorsPage() {
  const [data, saved] = await Promise.all([
    loadConfirmedProfessorPreviewData(),
    withOwnerData((repositories) => repositories.confirmedProfessors.list()),
  ]);
  return <main className="min-w-0">
    <div className={ui.pageHead}>
      <div><p className={ui.eyebrow}>Private discovery library</p><h1 className={ui.pageTitle}>Confirmed professors</h1><p className={ui.pageDescription}>People whose names and academic roles were confirmed from official profile pages. Confirmation is separate from research-interest fit and lead qualification.</p></div>
      {data.status === 'available' ? <span className={ui.status}>{data.result.professors.length} unique professors</span> : null}
    </div>

    <section className={`${ui.panel} ${ui.section}`} aria-label="Preview source and review status">
      <p className={ui.note}>MongoDB records below are the durable confirmed-professor library. Local discovery previews are shown separately and do not create MongoDB records or leads.</p>
      {data.status === 'available' ? <p className="mb-0 mt-3 text-xs leading-5 text-muted">Source: <span className="font-mono">{data.source}</span> · {data.countriesCovered} countries covered · {data.skippedCountries.length} skipped for missing verified hosts.</p> : null}
    </section>

    <section className={`${ui.section}`} aria-label="Saved confirmed professors">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2"><h2 className={ui.sectionTitle}>Saved in MongoDB</h2><span className={ui.eyebrow}>{saved.length} confirmed {saved.length === 1 ? 'professor' : 'professors'}</span></div>
      {saved.length ? <div className={ui.grid}>{saved.map((professor) => <article className={ui.panel} key={professor.stableId}>
        <div className={ui.cardTopline}><div><p className={ui.eyebrow}>{professor.country} · {professor.institution}</p><h3 className="mb-0 mt-1 font-display text-lg font-bold">{professor.name}</h3></div><span className={`${ui.tag} ${ui.professorTag}`}>Confirmed professor</span></div>
        <p className="mt-3 text-sm text-muted">Research status: {professor.researchStatus.replaceAll('_', ' ')}. Review: {professor.ownerDecision}.</p>
        <a className="break-all text-sm font-semibold text-green underline" href={professor.officialProfileUrl} target="_blank" rel="noreferrer">Open official profile</a>
        {professor.researchEvidence.length ? <ul className="mt-3 list-disc pl-5">{professor.researchEvidence.map((evidence, index) => <li key={`${evidence.sourceUrl}-${index}`}><a className="break-all text-sm text-green underline" href={evidence.sourceUrl} target="_blank" rel="noreferrer">Official research evidence</a><p className="text-sm text-muted">{evidence.quote}</p></li>)}</ul> : null}
        <p className="mb-0 mt-2 text-xs text-muted">Not approved for outreach, queued, or sent.</p>
      </article>)}</div> : <p className={ui.panel}>No confirmed professor records are saved in MongoDB yet.</p>}
    </section>

    {data.status === 'error' ? <section className={ui.panel} role="alert"><h2 className={ui.sectionTitle}>Preview reports could not be read</h2><p className="mb-0 text-sm text-muted">GradReach could not load the local discovery previews. No records were changed; try again later.</p></section> : null}

    {data.status === 'unavailable' ? <section className={ui.panel}><h2 className={ui.sectionTitle}>Local previews are not available yet</h2><p className="mb-0 text-sm text-muted">This section currently uses local discovery previews. Run an authorized no-write preview to populate it; this page does not search or write professor records.</p></section> : null}

    {data.status === 'available' && data.result.professors.length === 0 ? <section className={ui.panel}><h2 className={ui.sectionTitle}>No verified professors in the available reports</h2><p className="mb-0 text-sm text-muted">No report rows met the individual-name, academic-role, and official-profile evidence requirements.</p></section> : null}

    {data.status === 'available' && data.researchEnrichment.size > 0 ? <section className={`${ui.panel} ${ui.section}`} aria-label="Saved official research enrichment">
      <p className={ui.eyebrow}>Private local enrichment report</p><h2 className={ui.sectionTitle}>Latest official research checks</h2>
      <p className="mb-4 text-sm text-muted">{data.researchEnrichment.size} professors have saved enrichment diagnostics. Failed fetches and budget stops remain unevaluated; they are not marked as research mismatches.</p>
      <ul className="m-0 grid list-none gap-3 p-0">{[...data.researchEnrichment.values()].map((item) => <li className="rounded-xl border border-line bg-paper p-4" key={item.stableId}>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="m-0 font-semibold text-ink">{item.name} <span className="font-normal text-muted">Â· {item.institution}, {item.country}</span></p><span className={ui.tag}>{item.outcome.replaceAll('_', ' ')}</span></div>
        <p className="mb-1 mt-2 text-sm leading-6 text-muted">{item.explanation}</p>
        <p className="m-0 text-xs leading-5 text-muted">{item.traversal.pageFetches} official pages fetched; identity {item.traversal.identityEstablished ? 'reconfirmed' : 'not reconfirmed'}; research links {item.traversal.researchLinksFetched}/{item.traversal.researchLinksSelected} fetched{item.traversal.httpStatuses.length ? `; HTTP ${item.traversal.httpStatuses.join(', ')}` : ''}{item.failureCodes.length ? `; reason codes: ${item.failureCodes.join(', ')}` : ''}.</p>
        {item.researchEvidence ? <div className="mt-3"><blockquote className={`${ui.quote} my-0`}>{item.researchEvidence.quote}</blockquote><a className="mt-1 inline-block break-all text-xs font-semibold text-green underline underline-offset-2" href={item.researchEvidence.sourceUrl} target="_blank" rel="noreferrer">Open official research evidence source</a></div> : null}
        <p className="mb-0 mt-2 break-all text-xs text-muted">Official profile: <a className="font-semibold text-green underline underline-offset-2" href={item.officialProfileUrl} target="_blank" rel="noreferrer">open profile</a></p>
      </li>)}</ul>
    </section> : null}

    {data.status === 'available' && data.result.professors.length > 0 ? <>
      <section className={`${ui.grid} ${ui.section}`} aria-label="Confirmed professor records">
        {data.result.professors.map((professor) => <article className={`${ui.panel} flex min-w-0 flex-col`} key={professor.stableId}>
          <div className={ui.cardTopline}><div className="min-w-0"><p className={ui.eyebrow}>{professor.country} · {professor.institution}</p><h2 className="mb-0 mt-1 break-words font-display text-xl font-bold text-ink">{professor.name}</h2></div><span className={`${ui.tag} ${ui.professorTag}`}>Verified professor</span></div>
          <div className="mt-4 flex flex-wrap gap-2"><ResearchStatus status={professor.researchStatus}/><span className={ui.tag}>{professor.duplicate ? 'Duplicate noted in reports' : 'No duplicate noted'}</span></div>
          <p className="mb-1 mt-4 text-sm font-semibold text-ink">Research status explanation</p>
          <p className="m-0 text-sm leading-6 text-muted">{professor.researchStatusExplanation}</p>
          <p className="mb-0 mt-2 text-xs leading-5 text-muted">Professor confirmation is separate from lead qualification. This record remains pending review.</p>
          {professor.researchEvidence.length ? <div className="mt-4"><p className="mb-1 text-sm font-semibold text-ink">Available official research evidence</p><ul className="m-0 grid list-none gap-3 p-0">{professor.researchEvidence.map((evidence, index) => <li className="min-w-0" key={`${evidence.sourceUrl}-${index}`}><blockquote className={`${ui.quote} my-0`}>{evidence.quote}</blockquote><a className="mt-1 inline-block break-all text-xs font-semibold text-green underline underline-offset-2" href={evidence.sourceUrl} target="_blank" rel="noreferrer">Open official research source <span aria-hidden="true">↗</span></a></li>)}</ul></div> : <p className="mb-0 mt-4 text-sm text-muted">No supporting research excerpt was saved in the preview report.</p>}
          <div className="mt-4 rounded-xl border border-line bg-paper p-3"><p className="mb-1 text-xs font-semibold text-ink">Official profile</p><a className="break-all text-xs font-semibold text-green underline underline-offset-2" href={professor.officialProfileUrl} target="_blank" rel="noreferrer">Open verified profile <span aria-hidden="true">↗</span></a></div>
          {professor.localOwnerDecision === 'accepted_local_only' ? <p className="mb-0 mt-3 rounded-xl border border-green/20 bg-green-soft px-3 py-2 text-xs leading-5 text-green-dark">Accepted in the local owner-review preview only. It has not been saved to MongoDB and is not an outreach approval.</p> : null}
          <div className="mt-auto pt-4"><p className="mb-1 text-xs font-semibold text-ink">Source report{professor.sourceReports.length === 1 ? '' : 's'}</p><ul className="m-0 grid list-none gap-1 p-0">{professor.sourceReports.map((report) => <li className="break-all font-mono text-[10px] leading-5 text-muted" key={report}>{report}</li>)}</ul></div>
        </article>)}
      </section>

      <section className={`${ui.panel} ${ui.section}`} aria-label="Excluded preview rows">
        <div className={ui.cardTopline}><div><p className={ui.eyebrow}>Report audit</p><h2 className={`${ui.sectionTitle} mb-0 mt-1`}>Rows excluded or consolidated</h2></div><span className={ui.tag}>{Object.values(data.result.excludedByReason).reduce((sum, count) => sum + count, 0)} excluded · {data.result.duplicateRowsConsolidated} duplicate rows consolidated</span></div>
        <dl className="mb-0 mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">{Object.entries(data.result.excludedByReason).sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => <div className="flex min-w-0 justify-between gap-3 border-b border-line py-2" key={reason}><dt className="break-words text-muted">{reason.replaceAll('_', ' ')}</dt><dd className="m-0 shrink-0 font-mono font-semibold text-ink">{count}</dd></div>)}</dl>
      </section>
    </> : null}
  </main>;
}
