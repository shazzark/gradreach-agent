import { OFFICIAL_HOSTS_BY_REGION } from './official-host-allowlist.ts';
import type { OpportunitySearchSource } from '../domain/opportunity-discovery.ts';

export interface OfficialOpportunitySource {
  source: OpportunitySearchSource;
  organization: string;
  hosts: readonly string[];
}

// Each hostname is backed by a first-party program, scholarship database, or careers page.
const GLOBAL_OPPORTUNITY_SOURCES = [
  { source: 'scholarship', organization: 'Erasmus+', hosts: ['erasmus-plus.ec.europa.eu'] },
  { source: 'scholarship', organization: 'DAAD', hosts: ['www2.daad.de'] },
  { source: 'company', organization: 'Microsoft', hosts: ['careers.microsoft.com'] },
] satisfies readonly OfficialOpportunitySource[];

/** Returns only reviewed exact hosts. University hosts reuse the existing per-country allowlist. */
export function officialOpportunitySources(country: string): OfficialOpportunitySource[] {
  const universityHosts = (OFFICIAL_HOSTS_BY_REGION as Record<string, readonly string[]>)[country] ?? [];
  return [
    ...(universityHosts.length ? [{ source: 'university' as const, organization: 'Official university sources', hosts: universityHosts }] : []),
    ...GLOBAL_OPPORTUNITY_SOURCES,
  ].map((source) => ({ ...source, hosts: [...source.hosts] }));
}

export function opportunityKindForSource(source: OpportunitySearchSource): 'msc_program' | 'scholarship' | 'company_graduate_program' {
  return source === 'university' ? 'msc_program' : source === 'scholarship' ? 'scholarship' : 'company_graduate_program';
}
