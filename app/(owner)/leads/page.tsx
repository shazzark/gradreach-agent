import type { Metadata } from 'next';
import { LeadBrowser } from '../../../src/web/lead-browser.tsx';
import { getOwnerWorkspace } from '../../../src/web/owner-data.ts';

export const metadata: Metadata = { title: { absolute: 'GradReach | Leads and evidence' } };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ region?: string; type?: string; status?: string; state?: string }> }) {
  const [{ profile, candidates, triage, discoveryChecks }, query] = await Promise.all([getOwnerWorkspace(), searchParams]);
  const region = query.region && profile.applicant.target.countries.includes(query.region) ? query.region : undefined;
  return <LeadBrowser regions={profile.applicant.target.countries} candidates={candidates} triage={triage} discoveryChecks={discoveryChecks} selectedRegion={region} selectedType={query.type} selectedStatus={query.status} state={query.state}/>;
}
