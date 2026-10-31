import type { CandidateEvidenceTriage, ProfessorCandidate } from '../domain/outreach-queue.ts';
import { browseLeadsByDiscoveryRegion } from '../application/country-lead-browser.ts';
import { acceptLeadAction, rejectLeadAction, reviewEvidenceAction, runDiscoveryAction, runEvidenceTriageAction } from '../../app/actions.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { safeOfficialSourceUrl } from './safe-source-url.ts';

function LeadCard({ candidate, recommendation }: { candidate: ProfessorCandidate; recommendation?: CandidateEvidenceTriage | undefined }) {
  const evidence = candidate.discoveryEvidence ?? [];
  const professor = candidate.leadType === 'professor_profile' && candidate.professorName;
  return <article className="lead-card">
    <div className="card-topline"><span className={`tag ${professor ? 'tag-professor' : ''}`}>{professor ? 'Individual professor profile' : candidate.leadType ?? 'General / unclassified'}</span><span className="status">{candidate.status}</span></div>
    <h3>{professor ? candidate.professorName : candidate.name}</h3>
    {professor ? <p><strong>Page title:</strong> {candidate.name}</p> : <p>Professor identity: not established from an individual official profile.</p>}
    <p className="subtle">{candidate.institution || 'Institution unknown'} · Affiliation country: {candidate.country || 'Unknown'} · Discovery region: {candidate.searchRegion || 'Unknown'}</p>
    {candidate.discoveryReview ? <p className="outcome">Human lead decision: {candidate.discoveryReview.decision}</p> : null}
    {recommendation ? <div className="note"><strong>AI recommendation: {recommendation.recommendation}</strong><br/>{recommendation.rationale}<p className="muted">Advisory only; it does not accept, approve, or send.</p></div> : null}
    {evidence.length ? <div className="source-list section">
      {evidence.map((item, index) => {
        const href = safeOfficialSourceUrl(item.sourceUrl);
        return <div className="panel" key={`${candidate.id}-${index}`}>
          <div className="card-topline"><span className="tag">{item.kind} · {item.verification}</span><span className="mono">{item.retrievedAt.slice(0, 10)}</span></div>
          {href ? <p><a href={href} target="_blank" rel="noopener noreferrer">Open saved official source</a></p> : <p className="muted">Source link unavailable</p>}
          {item.quote ? <blockquote className="quote">{item.quote}</blockquote> : <p>{item.excerpt}</p>}
        </div>;
      })}
    </div> : <p className="muted">No saved evidence.</p>}
    {candidate.status === 'needs-evidence' && !candidate.discoveryReview && evidence.some((item) => ['official-page', 'professor-profile'].includes(item.kind)) ? <>
      <form action={reviewEvidenceAction} className="panel stack">
        <h4>Review identity and sources</h4>
        <label>Professor name exactly as shown on the selected official page<input name="professorName" maxLength={120} required/></label>
        <label>Selected individual profile source<select name="profileIndex" required>{evidence.map((item, index) => ['official-page', 'professor-profile'].includes(item.kind) ? <option key={index} value={index}>{item.kind}: {safeOfficialSourceUrl(item.sourceUrl) ?? 'Invalid source'}</option> : null)}</select></label>
        <fieldset><legend>Confirm each evidence source you reviewed</legend>{evidence.map((item, index) => <label className="check-row" key={index}><input type="checkbox" name="reviewedSourceIndex" value={index}/>{item.kind}: {safeOfficialSourceUrl(item.sourceUrl) ?? 'Invalid source'}</label>)}</fieldset>
        <input type="hidden" name="candidateId" value={candidate.id}/>
        <button type="submit">Save evidence review</button>
        <p className="muted">This records source review and professor classification only. It does not approve outreach.</p>
      </form>
      {professor ? <div className="actions">
        <form action={acceptLeadAction}><input type="hidden" name="candidateId" value={candidate.id}/><button type="submit">Accept lead for further review</button></form>
        <form action={rejectLeadAction}><input type="hidden" name="candidateId" value={candidate.id}/><button className="danger" type="submit">Reject lead</button></form>
      </div> : null}
    </> : null}
  </article>;
}

export function LeadBrowser({ regions, candidates, triage, selectedRegion, state }: {
  regions: string[]; candidates: ProfessorCandidate[]; triage: CandidateEvidenceTriage[]; selectedRegion?: string | undefined; state?: string | undefined;
}) {
  const selection = selectedRegion && regions.includes(selectedRegion) ? browseLeadsByDiscoveryRegion(candidates, selectedRegion) : undefined;
  const recommendations = new Map(triage.map((item) => [item.candidateId, item]));
  const discoverable = regions.filter((region) => Object.hasOwn(OFFICIAL_HOSTS_BY_REGION, region));
  return <main>
    <div className="page-head"><div><p className="eyebrow">Evidence-led discovery</p><h1>Leads &amp; evidence</h1><p>Search scope, saved pages, professor identity, and human review remain distinct.</p></div></div>
    <form id="triage-form" action={runEvidenceTriageAction}></form>
    {state === 'unavailable' ? <p className="warning" role="status">The requested operation could not be completed. Check the selected record and server configuration.</p> : state === 'saved' ? <p className="note" role="status">The requested operation completed.</p> : null}
    <section className="panel section"><form method="get" action="/leads" className="form-grid"><label>Browse by configured discovery country<select name="region" defaultValue={selectedRegion ?? ''}><option value="">All leads</option>{regions.map((region) => <option value={region} key={region}>{region}</option>)}</select></label><div className="actions"><button type="submit">Browse saved leads</button></div></form>
      {discoverable.length ? <form action={runDiscoveryAction} className="form-grid section"><label>One bounded search (up to three results)<select name="region" required>{discoverable.map((region) => <option value={region} key={region}>{region}</option>)}</select></label><div className="stack"><p className="muted">Uses only the documented exact-host allowlist for the selected country. One Brave request; no automatic retries.</p><button type="submit">Run one discovery request</button></div></form> : null}
    </section>
      {selection ? <><section className="section"><p className="note">Discovery region: <strong>{selection.region}</strong>. The region does not prove a professor's country or affiliation.</p><h2 className="section-title">Individual professor profiles ({selection.professors.length})</h2>
        {selection.professors.length ? <div className="list">{selection.professors.map((candidate) => <div key={candidate.id}><label className="check-row"><input type="checkbox" form="triage-form" name="candidateId" value={candidate.id}/><span>Include {candidate.professorName} in optional AI evidence triage. Triage can send a bounded excerpt to Gemini and never approves a lead.</span></label><LeadCard candidate={candidate} recommendation={recommendations.get(candidate.id)}/></div>)}</div> : <p className="panel muted">No individually supported professor profiles in this region.</p>}</section>
        <section className="section"><h2 className="section-title">General university, program, and research pages ({selection.general.length})</h2>{selection.general.length ? <div className="list">{selection.general.map((candidate) => <LeadCard key={candidate.id} candidate={candidate} recommendation={recommendations.get(candidate.id)}/>)}</div> : <p className="panel muted">No general leads in this region.</p>}</section></> : <section className="section"><h2 className="section-title">All saved leads ({candidates.length})</h2><div className="list">{candidates.map((candidate) => <LeadCard key={candidate.id} candidate={candidate} recommendation={recommendations.get(candidate.id)}/>)}</div></section>}
      <div className="actions"><button type="submit" form="triage-form">Run AI triage on selected profiles</button><span className="muted">Select 1–11 leads. Optional provider use; no review or sending state changes.</span></div>
  </main>;
}
