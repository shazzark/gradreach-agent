import { LeadBrowser } from '../../../src/web/lead-browser.tsx';
import { getOwnerWorkspace } from '../../../src/web/owner-data.ts';

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ region?: string; state?: string }> }) {
  const [{ profile, candidates, triage }, query] = await Promise.all([getOwnerWorkspace(), searchParams]);
  const region = query.region && profile.applicant.target.countries.includes(query.region) ? query.region : undefined;
  return <LeadBrowser regions={profile.applicant.target.countries} candidates={candidates} triage={triage} selectedRegion={region} state={query.state}/>;
}
