import type { Metadata } from 'next';
import { saveProfileAction } from '../../actions.ts';
import { createEmptyApplicantProfile, isApplicantProfileIncomplete } from '../../../src/domain/applicant-profile.ts';
import { withOwnerData } from '../../../src/web/owner-data.ts';
import { ui } from '../../../src/web/ui-classes.ts';
import { ResearchPreferencesEditor } from '../../../src/web/research-preferences-editor.tsx';

export const metadata: Metadata = { title: { absolute: 'GradReach | Profile settings' } };

const optional = <span className="font-normal text-muted">(optional)</span>;
const formGrid = 'grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3';

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const [savedProfile, query] = await Promise.all([
    withOwnerData((repositories) => repositories.profiles.get('primary')),
    searchParams,
  ]);
  const profile = savedProfile ?? createEmptyApplicantProfile();
  const { applicant } = profile;
  const { degree, target, englishEvidence, documents } = applicant;
  const setupNeeded = isApplicantProfileIncomplete(savedProfile);
  return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Private settings</p><h1 className={ui.pageTitle}>{setupNeeded ? 'Set up your profile' : 'Applicant profile'}</h1><p className={ui.pageDescription}>These editable details are saved in your private profile. Unknown optional information can stay blank; no transcript is required.</p></div><span className={ui.tag}>{setupNeeded ? 'Setup needed' : 'Profile ready'}</span></div>
    {query.state === 'saved' ? <p className={ui.note} role="status">Profile saved.</p> : query.state === 'unavailable' ? <p className={ui.warning} role="status">Profile could not be saved. Check required values and try again.</p> : null}
    {setupNeeded ? <p className={ui.warning} role="status">Some core study or target settings are incomplete. Save the information you know and return to this page when you have more details.</p> : null}
    <form action={saveProfileAction} className={`${ui.stack} w-full`}>
      <section className={ui.panel}>
        <h2 className={ui.sectionTitle}>Applicant</h2>
        <div className={formGrid}>
          <label className={ui.formLabel}>Full name {optional}<input className={ui.input} name="fullName" defaultValue={applicant.fullName} maxLength={160}/></label>
          <label className={ui.formLabel}>Email {optional}<input className={ui.input} name="email" type="email" defaultValue={applicant.email} maxLength={254}/></label>
          <label className={ui.formLabel}>Phone number {optional}<input className={ui.input} name="phone" type="tel" defaultValue={applicant.phone} maxLength={80}/></label>
          <label className={ui.formLabel}>Nationality<input className={ui.input} name="nationality" defaultValue={applicant.nationality} maxLength={100} required/></label>
          <label className={ui.formLabel}>Current location<input className={ui.input} name="currentLocation" defaultValue={applicant.currentLocation} maxLength={160} required/></label>
        </div>
      </section>

      <section className={ui.panel}>
        <h2 className={ui.sectionTitle}>Current degree</h2>
        <div className={formGrid}>
          <label className={ui.formLabel}>Degree title<input className={ui.input} name="degreeTitle" defaultValue={degree.title} maxLength={160} required/></label>
          <label className={ui.formLabel}>Institution<input className={ui.input} name="degreeInstitution" defaultValue={degree.institution} maxLength={200} required/></label>
          <label className={ui.formLabel}>Institution country<input className={ui.input} name="degreeCountry" defaultValue={degree.country} maxLength={100} required/></label>
          <label className={ui.formLabel}>Graduation year<input className={ui.input} name="graduationYear" type="number" min="1900" max="2200" step="1" defaultValue={degree.graduationYear ?? ''} required/></label>
          <label className={ui.formLabel}>Classification<input className={ui.input} name="classification" defaultValue={degree.classification} maxLength={100} required/></label>
          <label className={ui.formLabel}>CGPA<input className={ui.input} name="gpa" type="number" min="0" step="any" defaultValue={degree.gpa ?? ''} required/></label>
          <label className={ui.formLabel}>GPA scale {optional}<input className={ui.input} name="gpaScale" type="number" min="0" step="any" defaultValue={degree.gpaScale ?? ''}/></label>
          <label className={ui.formLabel}>Grading-scale document path {optional}<input className={ui.input} name="gradingScaleDocument" defaultValue={degree.gradingScaleDocument} maxLength={1000}/></label>
        </div>
      </section>

      <section className={ui.panel}>
        <h2 className={ui.sectionTitle}>Target study</h2>
        <div className={formGrid}>
          <div className="min-w-0 xl:col-span-3"><ResearchPreferencesEditor countries={target.countries} interests={target.researchInterests}/><p className={`${ui.muted} mb-0 mt-2 text-xs`}>Saved preferences control manual and scheduled discovery. Custom interests are allowed; unsupported countries remain selected but are skipped until their exact official host is verified.</p></div>
          <label className={ui.formLabel}>Target degree field(s), comma separated<input className={ui.input} name="fields" defaultValue={target.fields.join(', ')} maxLength={2000} required/></label>
          <label className={ui.formLabel}>Target intake<input className={ui.input} name="intake" defaultValue={target.intake} maxLength={120} required/></label>
          <label className={ui.formLabel}>Funding preferences, comma separated<input className={ui.input} name="fundingTypes" defaultValue={target.fundingTypes.join(', ')} maxLength={1000} required/></label>
          <label className={ui.formLabel}>Timezone<input className={ui.input} name="timezone" defaultValue={target.timezone} maxLength={80} required/></label>
          <label className={ui.formLabel}>Maximum annual tuition {optional}<input className={ui.input} name="maxAnnualTuition" type="number" min="0" step="any" defaultValue={target.maxAnnualTuition ?? ''}/></label>
          <label className={ui.formLabel}>Tuition currency {optional}<input className={ui.input} name="tuitionCurrency" defaultValue={target.tuitionCurrency} maxLength={3}/></label>
        </div>
      </section>

      <section className={ui.panel}>
        <h2 className={ui.sectionTitle}>English-test details</h2>
        <div className={formGrid}>
          <label className={ui.formLabel}>Test status {optional}<input className={ui.input} name="testStatus" defaultValue={englishEvidence.testStatus} maxLength={80}/></label>
          <label className={ui.formLabel}>Test name {optional}<input className={ui.input} name="testName" defaultValue={englishEvidence.testName} maxLength={100}/></label>
          <label className={ui.formLabel}>Score {optional}<input className={ui.input} name="testScore" defaultValue={englishEvidence.score} maxLength={80}/></label>
          <label className={ui.formLabel}>Test date {optional}<input className={ui.input} name="testDate" type="date" defaultValue={englishEvidence.testDate} maxLength={40}/></label>
          <label className={ui.formLabel}>Medium-of-instruction letter path {optional}<input className={ui.input} name="mediumOfInstructionLetter" defaultValue={englishEvidence.mediumOfInstructionLetter} maxLength={1000}/></label>
        </div>
      </section>

      <section className={ui.panel}>
        <h2 className={ui.sectionTitle}>Documents and links</h2>
        <p>All paths and links are optional. A transcript is not needed to save this profile.</p>
        <div className={formGrid}>
          <label className={ui.formLabel}>CV file path {optional}<input className={ui.input} name="academicCvPath" defaultValue={documents.academicCvPath} maxLength={1000}/></label>
          <label className={ui.formLabel}>Transcript file path {optional}<input className={ui.input} name="transcriptPath" defaultValue={documents.transcriptPath} maxLength={1000}/></label>
          <label className={ui.formLabel}>Portfolio URL {optional}<input className={ui.input} name="portfolioUrl" type="url" defaultValue={documents.portfolioUrl} maxLength={2000}/></label>
          <label className={ui.formLabel}>GitHub URL {optional}<input className={ui.input} name="githubUrl" type="url" defaultValue={documents.githubUrl} maxLength={2000}/></label>
          <label className={`${ui.formLabel} xl:col-span-2`}>Project URLs, comma separated {optional}<textarea className={ui.input} name="projectUrls" defaultValue={documents.projectUrls.join(', ')} maxLength={5000}/></label>
        </div>
      </section>

      <button className={`${ui.primaryButton} justify-self-start`} type="submit">Save private profile</button>
      <p className={`${ui.muted} m-0 text-sm`}>Saving profile settings does not verify leads, change approvals, or send email.</p>
    </form>
  </main>;
}
