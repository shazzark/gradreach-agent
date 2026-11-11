import type { Metadata } from 'next';
import { approveDraftAction, saveDraftAction } from '../../actions.ts';
import { getOwnerWorkspace } from '../../../src/web/owner-data.ts';
import { safeOfficialSourceUrl } from '../../../src/web/safe-source-url.ts';
import { ui } from '../../../src/web/ui-classes.ts';

export const metadata: Metadata = { title: { absolute: 'GradReach | Draft review' } };

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
  const reviewCandidates = candidates.filter((candidate) => candidate.status === 'ready-for-review' || Boolean(candidate.personalizedDraft));
  return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Human review required</p><h1 className={ui.pageTitle}>Draft review</h1><p className={ui.pageDescription}>Check each saved draft and its source before taking an individual approval action. Saving a draft never approves or sends it.</p></div><span className={ui.tag}>{reviewCandidates.length} to review</span></div>
    {query.state === 'unavailable' ? <p className={ui.warning} role="status">Draft operation was not completed. Verify the source evidence and candidate state.</p> : query.state === 'saved' ? <p className={ui.note} role="status">Draft operation completed.</p> : null}
    {reviewCandidates.length ? <div className={ui.list}>{reviewCandidates.map((candidate) => {
      const profileEvidence = candidate.discoveryEvidence?.find((item) => item.kind === 'professor-profile' && item.verification === 'reviewed' && item.sourceUrl === candidate.officialProfileUrl);
      const draft = savedDraft(candidate.personalizedDraft);
      const source = draft ? safeOfficialSourceUrl(draft.personalizationSourceUrl) : undefined;
      return <article className={`${ui.panel} min-w-0`} key={candidate.id}>
        <div className={ui.cardTopline}><div className="min-w-0"><p className={ui.eyebrow}>Professor name</p><h2 className="mb-0 mt-1 break-words font-display text-lg font-bold">{candidate.professorName?.trim() || 'Not established from an individual official profile'}</h2><p className="mb-0 mt-1 break-words text-sm text-muted"><strong>Saved page title:</strong> {candidate.name}</p></div><span className={ui.status}>{candidate.status}</span></div>
        <dl className="mt-4 grid min-w-0 grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-2"><div className="min-w-0 break-words"><dt className={ui.eyebrow}>Institution</dt><dd className="mb-0 mt-1">{candidate.institution || 'Unknown'}</dd></div><div className="min-w-0 break-words"><dt className={ui.eyebrow}>Source-backed email</dt><dd className="mb-0 mt-1">{candidate.officialEmail || 'Not available'}</dd></div></dl>
        {draft ? <div className="mt-4 min-w-0 rounded-2xl border border-line bg-paper p-4 sm:p-5"><div className="grid min-w-0 gap-3"><p className="m-0 break-words"><strong>Subject:</strong> {draft.subject}</p><p className="m-0 break-all"><strong>Recipient:</strong> {draft.recipientEmail}</p><div><p className="mb-1 font-semibold">Message draft</p><pre className="m-0 max-w-full whitespace-pre-wrap break-words font-sans text-sm leading-6 [overflow-wrap:anywhere]">{draft.body}</pre></div><p className={`${ui.muted} m-0 break-words text-sm [overflow-wrap:anywhere]`}><strong>Personalization excerpt:</strong> “{draft.personalizationExcerpt}” <span aria-hidden="true">·</span> {source ? <a className="break-all font-semibold text-green underline underline-offset-4" href={source} target="_blank" rel="noopener noreferrer">View source</a> : 'Source link unavailable'}</p></div></div> : null}
        {candidate.status === 'ready-for-review' && profileEvidence ? <form action={saveDraftAction} className={`${ui.stack} mt-5 border-t border-line pt-5`}><label className={ui.formLabel}>Exact research passage from the reviewed profile<textarea className={ui.textarea} name="researchExcerpt" maxLength={240} minLength={24} required defaultValue={profileEvidence.quote ?? ''}/></label><input type="hidden" name="candidateId" value={candidate.id}/><button className={`${ui.primaryButton} justify-self-start`} type="submit">Save deterministic draft for review</button></form> : null}
        {draft && candidate.status === 'ready-for-review' ? <form action={approveDraftAction} className={`${ui.stack} mt-5 border-t border-line pt-5`}><input type="hidden" name="candidateId" value={candidate.id}/><p className={ui.warning}>Approval applies to this exact draft. Delivery still requires separate Gmail authorization and the existing sending safeguards.</p><button className={`${ui.dangerButton} justify-self-start`} type="submit">Approve this draft for the outreach queue</button></form> : null}
      </article>;
    })}</div> : <section className={`${ui.panel} ${ui.section}`}><p className={ui.eyebrow}>Nothing waiting</p><h2 className="mb-1 mt-2 font-display text-xl font-bold">No drafts are ready for review</h2><p className="mb-0 text-sm text-muted">A draft appears here after its professor profile evidence has been reviewed and a draft has been prepared.</p></section>}
  </main>;
}
