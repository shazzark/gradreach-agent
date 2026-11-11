import type { CandidateEvidenceTriage, ProfessorCandidate } from '../domain/outreach-queue.ts';
import type { DiscoveryEvidenceCheck } from '../application/automatic-discovery.ts';
import { browseLeadsByDiscoveryRegion } from '../application/country-lead-browser.ts';
import { acceptLeadAction, rejectLeadAction, reviewEvidenceAction, runDiscoveryAction, runEvidenceTriageAction } from '../../app/actions.ts';
import { evidenceCardView, leadCardView } from './lead-card-view.ts';
import { ui } from './ui-classes.ts';
import { discoveryCountryCoverage } from '../domain/discovery-country-coverage.ts';

function LeadCard({ candidate, recommendation, researchChecks = [] }: { candidate: ProfessorCandidate; recommendation?: CandidateEvidenceTriage | undefined; researchChecks?: DiscoveryEvidenceCheck[] }) {
  const evidence = candidate.discoveryEvidence ?? [];
  const view = leadCardView(candidate);
  const professor = candidate.leadType === 'professor_profile' && Boolean(candidate.professorName?.trim());
  return <article className={`${ui.leadCard} break-words`}>
    <div className={ui.cardTopline}><span className={`${ui.tag} ${professor ? ui.professorTag : ''}`}>{professor ? 'Individual professor profile' : view.leadType}</span><span className={ui.status}>Lead status: {view.status}</span></div>
    <h3 className="my-2 break-words font-display text-[17px] font-bold">{view.pageTitle}</h3>
    <dl className="my-3 grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-2">
      <div className="min-w-0 break-words"><dt className={ui.eyebrow}>Saved page title</dt><dd className="m-0">{view.pageTitle}</dd></div>
      <div className="min-w-0 break-words"><dt className={ui.eyebrow}>Professor name</dt><dd className="m-0">{view.professorName}</dd></div>
      <div className="min-w-0 break-words"><dt className={ui.eyebrow}>Institution</dt><dd className="m-0">{view.institution}</dd></div>
      <div className="min-w-0 break-words"><dt className={ui.eyebrow}>Affiliation country</dt><dd className="m-0">{view.country}</dd></div>
      <div className="min-w-0 break-words"><dt className={ui.eyebrow}>Discovery region</dt><dd className="m-0">{view.discoveryRegion}</dd></div>
      <div className="min-w-0 break-words"><dt className={ui.eyebrow}>Lead review</dt><dd className="m-0">{view.reviewDecision}</dd></div>
    </dl>
    {recommendation ? <div className={`${ui.note} my-3 break-words`}><strong>AI recommendation: {recommendation.recommendation}</strong><br/>{recommendation.rationale}<p className="mb-0 mt-2 text-sm text-muted">Advisory only; it does not accept, approve, or send.</p></div> : null}
    {researchChecks.length ? <section className="my-4 grid min-w-0 gap-3" aria-label="Prepared research recommendations"><h4 className="m-0 font-display text-base font-bold">Prepared research evidence</h4>{researchChecks.map((check) => {
      const prepared = check.evidencePackage;
      return <article className={`${ui.panel} min-w-0`} key={check.id}>
        <div className={ui.cardTopline}><strong>{prepared?.recommendation ?? (check.outcome === 'failed' ? 'Evidence check failed' : 'Evidence needs review')}</strong><span className={ui.eyebrow}>Checked {check.checkedAt}</span></div>
        <p className="my-2 break-words text-sm">{prepared?.rationale ?? check.failureCode ?? 'No complete recommendation package was produced.'}</p>
        <p className="mb-2 text-xs text-muted">Affiliation: {prepared?.affiliation.status ?? 'uncertain'}{prepared?.affiliation.institution ? ` · ${prepared.affiliation.institution}` : ''}</p>
        {prepared?.researchQuote ? <blockquote className={ui.quote}>{prepared.researchQuote}</blockquote> : null}
        {prepared?.matchedInterests.length ? <p className="mb-2 text-sm"><strong>Matching saved interests:</strong> {prepared.matchedInterests.join(', ')}</p> : null}
        {prepared?.uncertaintyReasons.length ? <p className="mb-2 text-sm text-amber">Uncertain because: {prepared.uncertaintyReasons.join(' ')}</p> : null}
        <a className="break-all text-sm text-green underline" href={prepared?.sourceUrl ?? check.sourceUrl} target="_blank" rel="noopener noreferrer">Open official profile source</a>
      </article>;
    })}</section> : null}
    {evidence.length ? <div className={`${ui.sourceList} ${ui.section}`}>
      {evidence.map((item, index) => {
        const evidenceView = evidenceCardView(item);
        return <div className={`${ui.panel} break-words`} key={`${candidate.id}-${index}`}>
          <div className={ui.cardTopline}><span className={ui.tag}>{item.kind} · Verification: {evidenceView.verification}</span><span className={ui.eyebrow}>Saved: {evidenceView.retrievedDate}</span></div>
          {evidenceView.sourceUrl ? <p className="break-all"><a className="text-green underline underline-offset-4 hover:text-green-dark" href={evidenceView.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open official source: ${evidenceView.sourceUrl}`}>{evidenceView.sourceUrl}</a></p> : <p className={ui.muted}>Official source URL unavailable</p>}
          <p className="[overflow-wrap:anywhere]">{evidenceView.excerptPreview || 'Saved excerpt unavailable'}</p>
          {evidenceView.fullExcerpt.length > evidenceView.excerptPreview.length ? <details className="mt-2 rounded-md border border-line p-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold">Show full saved excerpt</summary><p className="mb-0 [overflow-wrap:anywhere]">{evidenceView.fullExcerpt}</p></details> : null}
        </div>;
      })}
    </div> : <p className={ui.muted}>No saved evidence.</p>}
    {candidate.status === 'needs-evidence' && !candidate.discoveryReview && evidence.some((item) => ['official-page', 'professor-profile'].includes(item.kind)) ? <>
      <form action={reviewEvidenceAction} className={`${ui.panel} ${ui.stack}`}>
        <h4 className="m-0 font-display text-base font-bold">Review identity and sources</h4>
        <label className={ui.formLabel}>Professor name exactly as shown on the selected official page<input className={ui.input} name="professorName" maxLength={120} required/></label>
        <label className={ui.formLabel}>Selected individual profile source<select className={ui.input} name="profileIndex" required>{evidence.map((item, index) => ['official-page', 'professor-profile'].includes(item.kind) ? <option key={index} value={index}>{item.kind}: {evidenceCardView(item).sourceUrl ?? 'Invalid source'}</option> : null)}</select></label>
        <fieldset className={ui.fieldset}><legend className="px-1 text-sm font-semibold">Confirm each evidence source you reviewed</legend>{evidence.map((item, index) => <label className={ui.checkRow} key={index}><input className="mt-1 size-5 shrink-0 accent-green" type="checkbox" name="reviewedSourceIndex" value={index}/><span className="min-w-0 break-words">{item.kind}: {evidenceCardView(item).sourceUrl ?? 'Invalid source'}</span></label>)}</fieldset>
        <input type="hidden" name="candidateId" value={candidate.id}/>
        <button className={`${ui.primaryButton} justify-self-start`} type="submit">Save evidence review</button>
        <p className="m-0 text-sm text-muted">This records source review and professor classification only. It does not approve outreach.</p>
      </form>
      {professor ? <div className={ui.actions}>
        <form action={acceptLeadAction}><input type="hidden" name="candidateId" value={candidate.id}/><button className={ui.primaryButton} type="submit">Accept lead for further review</button></form>
        <form action={rejectLeadAction}><input type="hidden" name="candidateId" value={candidate.id}/><button className={ui.dangerButton} type="submit">Reject lead</button></form>
      </div> : null}
    </> : null}
  </article>;
}
export function LeadBrowser({ regions, candidates, triage, discoveryChecks = [], selectedRegion, selectedType, selectedStatus, state }: {
  regions: string[]; candidates: ProfessorCandidate[]; triage: CandidateEvidenceTriage[]; discoveryChecks?: DiscoveryEvidenceCheck[];
  selectedRegion?: string | undefined; selectedType?: string | undefined; selectedStatus?: string | undefined; state?: string | undefined;
}) {
  const filteredCandidates = candidates.filter((candidate) => (!selectedType || candidate.leadType === selectedType) && (!selectedStatus || candidate.status === selectedStatus));
  const selection = selectedRegion && regions.includes(selectedRegion) ? browseLeadsByDiscoveryRegion(filteredCandidates, selectedRegion) : undefined;
  const recommendations = new Map(triage.map((item) => [item.candidateId, item]));
  const checksByCandidate = new Map<string, DiscoveryEvidenceCheck[]>();
  for (const check of discoveryChecks) checksByCandidate.set(check.candidateId, [...(checksByCandidate.get(check.candidateId) ?? []), check]);
  const coverage = discoveryCountryCoverage(regions);
  const discoverable = coverage.filter((entry) => entry.status === 'verified').map((entry) => entry.country);
  const leadTypes = [...new Set(candidates.map((candidate) => candidate.leadType).filter((value): value is NonNullable<typeof value> => Boolean(value)))].sort();
  const leadStatuses = [...new Set(candidates.map((candidate) => candidate.status))].sort();
  return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Research discovery</p><h1 className={ui.pageTitle}>Leads &amp; evidence</h1><p className={ui.pageDescription}>Review saved official pages, professor identities, source excerpts, and human decisions.</p></div><span className={ui.tag}>{candidates.length} saved {candidates.length === 1 ? 'lead' : 'leads'}</span></div>
    <form id="triage-form" action={runEvidenceTriageAction}/>
    {state === 'unavailable' ? <p className={ui.warning} role="status">The requested operation could not be completed. Check the selected record and server configuration.</p> : state === 'saved' ? <p className={ui.note} role="status">The requested operation completed.</p> : null}
    <section className={`${ui.panel} ${ui.section}`}>
      <div className="mb-4"><p className={ui.eyebrow}>Browse saved records</p><h2 className={`${ui.sectionTitle} mb-0 mt-1`}>Filter leads</h2></div>
      <form method="get" action="/leads" className="grid min-w-0 grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className={ui.formLabel}>Discovery region<select className={ui.input} name="region" defaultValue={selectedRegion ?? ''}><option value="">All regions</option>{regions.map((region) => <option value={region} key={region}>{region}</option>)}</select></label>
        <label className={ui.formLabel}>Lead type<select className={ui.input} name="type" defaultValue={selectedType ?? ''}><option value="">All types</option>{leadTypes.map((type) => <option value={type} key={type}>{type.replaceAll('_', ' ')}</option>)}</select></label>
        <label className={ui.formLabel}>Lead status<select className={ui.input} name="status" defaultValue={selectedStatus ?? ''}><option value="">All statuses</option>{leadStatuses.map((status) => <option value={status} key={status}>{status.replaceAll('-', ' ')}</option>)}</select></label>
        <button className={ui.primaryButton} type="submit">Apply filters</button>
      </form>
      <div className="mt-5 rounded-2xl border border-line bg-paper p-4"><p className={ui.eyebrow}>Configured country coverage</p><div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">{coverage.map((item) => <p className="m-0 break-words text-sm" key={item.country}><strong>{item.country}:</strong> {item.status === 'verified' ? `covered (${item.officialHosts.join(', ')})` : item.message}</p>)}</div></div>
      {discoverable.length ? <div className="mt-5 rounded-2xl border border-line bg-paper p-4 sm:flex sm:items-center sm:justify-between sm:gap-5"><div className="mb-3 min-w-0 sm:mb-0"><p className={ui.eyebrow}>Bounded evidence gathering</p><p className="mb-0 mt-1 text-sm text-muted">One request capped at three results. A named professor profile and a matching research quote must come from linked, allowlisted official pages.</p></div><form action={runDiscoveryAction} className="flex min-w-0 flex-wrap items-end gap-2"><label className={`${ui.formLabel} min-w-[170px] flex-1`}>Configured country<select className={ui.input} name="region" required>{discoverable.map((region) => <option value={region} key={region}>{region}</option>)}</select></label><button className={ui.secondaryButton} type="submit">Prepare evidence</button></form></div> : <p className={`${ui.warning} mt-4`}>Discovery is skipped for every selected country because none has a verified exact official host.</p>}
    </section>
    {selection ? <>
      <section className={ui.section}><p className={ui.note}>Discovery target: <strong>{selection.region}</strong>. Each recommendation separately reports affiliation evidence from its exact official profile host.</p><h2 className={ui.sectionTitle}>Individual professor profiles ({selection.professors.length})</h2>
        {selection.professors.length ? <div className={ui.list}>{selection.professors.map((candidate) => <div className="min-w-0" key={candidate.id}><label className={ui.checkRow}><input className="mt-1 size-5 shrink-0 accent-green" type="checkbox" form="triage-form" name="candidateId" value={candidate.id}/><span className="min-w-0 break-words">Include {candidate.professorName} in optional AI evidence triage. Triage does not approve a lead.</span></label><LeadCard candidate={candidate} recommendation={recommendations.get(candidate.id)} researchChecks={checksByCandidate.get(candidate.id) ?? []}/></div>)}</div> : <p className={`${ui.panel} ${ui.muted}`}>No individually supported professor profiles in this region.</p>}
      </section>
      <section className={ui.section}><h2 className={ui.sectionTitle}>General university, program, and research pages ({selection.general.length})</h2>{selection.general.length ? <div className={ui.list}>{selection.general.map((candidate) => <LeadCard key={candidate.id} candidate={candidate} recommendation={recommendations.get(candidate.id)} researchChecks={checksByCandidate.get(candidate.id) ?? []}/>)}</div> : <p className={`${ui.panel} ${ui.muted}`}>No general leads in this region.</p>}</section>
    </> : <section className={ui.section}><div className="mb-3 flex flex-wrap items-end justify-between gap-2"><h2 className={ui.sectionTitle}>Saved leads</h2><span className={ui.eyebrow}>{filteredCandidates.length} matching records</span></div>{filteredCandidates.length ? <div className={ui.list}>{filteredCandidates.map((candidate) => <LeadCard key={candidate.id} candidate={candidate} recommendation={recommendations.get(candidate.id)} researchChecks={checksByCandidate.get(candidate.id) ?? []}/>)}</div> : <p className={`${ui.panel} ${ui.muted}`}>{candidates.length ? 'No saved leads match these filters.' : 'No saved leads are available yet. Review country coverage and saved preferences before starting evidence gathering.'}</p>}</section>}
    {selection?.professors.length ? <div className={`${ui.panel} mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`}><div><h2 className="m-0 font-display text-base font-bold">Optional AI evidence triage</h2><p className="mb-0 mt-1 text-sm text-muted">Select professor profiles to prepare advisory recommendations. Triage does not review or approve leads.</p></div><button className={ui.secondaryButton} type="submit" form="triage-form">Run triage on selected profiles</button></div> : null}
  </main>;
}
