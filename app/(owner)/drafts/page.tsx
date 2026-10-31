import { approveDraftAction, saveDraftAction } from '../../actions.ts';
import { getOwnerWorkspace } from '../../../src/web/owner-data.ts';
import { safeOfficialSourceUrl } from '../../../src/web/safe-source-url.ts';

interface SavedDraft { subject: string; body: string; recipientEmail: string; personalizationSourceUrl: string; personalizationExcerpt: string }
function savedDraft(value: string | undefined): SavedDraft | undefined {
  if (!value) return undefined;
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    if (['subject','body','recipientEmail','personalizationSourceUrl','personalizationExcerpt'].every((field) => typeof data[field] === 'string')) return data as unknown as SavedDraft;
  } catch { /* malformed legacy drafts stay hidden until regenerated */ }
  return undefined;
}

export default async function DraftsPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const [{ candidates }, query] = await Promise.all([getOwnerWorkspace(), searchParams]);
  return <main><div className="page-head"><div><p className="eyebrow">Human review gate</p><h1>Draft review</h1><p>Drafts use the existing source-cited generator. Saving a draft never approves or sends it.</p></div></div>
    {query.state === 'unavailable' ? <p className="warning" role="status">Draft operation was not completed. Verify the source evidence and candidate state.</p> : query.state === 'saved' ? <p className="note" role="status">Draft operation completed.</p> : null}
    <div className="list">{candidates.filter((candidate) => candidate.status === 'ready-for-review' || Boolean(candidate.personalizedDraft)).map((candidate) => {
      const profileEvidence = candidate.discoveryEvidence?.find((item) => item.kind === 'professor-profile' && item.verification === 'reviewed' && item.sourceUrl === candidate.officialProfileUrl);
      const draft = savedDraft(candidate.personalizedDraft);
      return <article className="panel" key={candidate.id}><div className="card-topline"><h2 className="section-title">{candidate.professorName ?? candidate.name}</h2><span className="status">{candidate.status}</span></div><p>{candidate.institution || 'Institution unknown'} · {candidate.officialEmail ?? 'No source-backed email'}</p>
        {draft ? <div className="panel section"><p><strong>Subject:</strong> {draft.subject}</p><p><strong>To:</strong> {draft.recipientEmail}</p><pre style={{whiteSpace:'pre-wrap',fontFamily:'inherit'}}>{draft.body}</pre><p className="muted">Personalization excerpt: “{draft.personalizationExcerpt}” · <a href={safeOfficialSourceUrl(draft.personalizationSourceUrl)} target="_blank" rel="noopener noreferrer">source</a></p></div> : null}
        {candidate.status === 'ready-for-review' && profileEvidence ? <form action={saveDraftAction} className="stack section"><label>Exact research passage from the reviewed profile<textarea name="researchExcerpt" maxLength={240} minLength={24} required defaultValue={profileEvidence.quote ?? ''}/></label><input type="hidden" name="candidateId" value={candidate.id}/><button type="submit">Save deterministic draft for review</button></form> : null}
        {draft && candidate.status === 'ready-for-review' ? <form action={approveDraftAction} className="stack section"><input type="hidden" name="candidateId" value={candidate.id}/><p className="warning">Approval authorizes the existing scheduler to deliver this exact draft only if Gmail is separately connected and sending is explicitly enabled. This website action itself does not send.</p><button type="submit">Approve this exact draft for the outreach queue</button></form> : null}
      </article>;
    })}</div>
  </main>;
}
