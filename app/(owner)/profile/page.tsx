import { saveProfileAction } from '../../actions.ts';
import { getOwnerWorkspace } from '../../../src/web/owner-data.ts';

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const [{ profile }, query] = await Promise.all([getOwnerWorkspace(), searchParams]);
  const target = profile.applicant.target;
  return <main><div className="page-head"><div><p className="eyebrow">Private profile settings</p><h1>Research priorities</h1><p>Stored through the existing MongoDB profile repository. Personal documents and credentials are not rendered here.</p></div></div>
    {query.state === 'saved' ? <p className="note" role="status">Profile settings saved.</p> : query.state === 'unavailable' ? <p className="warning" role="status">Profile settings could not be saved. Check the values and try again.</p> : null}
    <section className="panel"><p><strong>{profile.applicant.fullName}</strong> · {profile.applicant.degree.title} · {profile.applicant.degree.institution}</p><form action={saveProfileAction} className="stack section">
      <div className="form-grid"><label>Target countries (comma separated)<input name="countries" defaultValue={target.countries.join(', ')} maxLength={3000} required/></label><label>Academic fields<input name="fields" defaultValue={target.fields.join(', ')} maxLength={3000} required/></label><label>Research interests<input name="researchInterests" defaultValue={target.researchInterests.join(', ')} maxLength={3000} required/></label><label>Funding preferences<input name="fundingTypes" defaultValue={target.fundingTypes.join(', ')} maxLength={3000}/></label><label>Target intake<input name="intake" defaultValue={target.intake} maxLength={120}/></label><label>Timezone<input name="timezone" defaultValue={target.timezone} maxLength={80} required/></label><label>Maximum annual tuition<input name="maxAnnualTuition" type="number" min="0" step="any" defaultValue={target.maxAnnualTuition ?? ''}/></label><label>Tuition currency<input name="tuitionCurrency" defaultValue={target.tuitionCurrency} maxLength={3}/></label></div>
      <button type="submit">Save profile settings</button><p className="muted">Changing interests or countries does not verify leads or program claims.</p>
    </form></section>
  </main>;
}
