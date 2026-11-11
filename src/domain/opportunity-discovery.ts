export type OpportunitySearchSource = 'university' | 'scholarship' | 'company';
export type OpportunityStopReason =
  | 'no_verified_host'
  | 'missing_configuration'
  | 'missing_research_interests'
  | 'provider_failure'
  | 'no_results'
  | 'unverified_result_host'
  | 'page_fetch_failed'
  | 'page_fetch_budget'
  | 'country_not_confirmed'
  | 'no_interest_match'
  | 'invalid_official_record'
  | 'duplicate_source'
  | 'duplicate_identity'
  | 'saved';

export interface OpportunitySourceRun {
  country: string;
  source: OpportunitySearchSource;
  hosts: string[];
  state: 'completed' | 'failed' | 'skipped';
  counts: { searches: number; results: number; pagesFetched: number; interestMatches: number; saved: number; duplicates: number; rejected: number; failures: number };
  stopReasons: OpportunityStopReason[];
}

/** Content-free history stored beside existing professor discovery runs in the same collection. */
export interface OpportunityDiscoveryRun {
  system: 'opportunity';
  id: string;
  trigger: 'manual';
  startedAt: string;
  completedAt?: string;
  countries: string[];
  state: 'running' | 'completed' | 'partial' | 'failed';
  counts: { searches: number; results: number; pagesFetched: number; interestMatches: number; saved: number; duplicates: number; rejected: number; failures: number };
  sources: OpportunitySourceRun[];
  stopReasons: OpportunityStopReason[];
}

export const OPPORTUNITY_DISCOVERY_LIMITS = { countriesPerRun: 5, sourcesPerCountry: 4, resultsPerSearch: 3, pageFetchesPerRun: 15 } as const;

const SOURCE_VALUES: readonly OpportunitySearchSource[] = ['university', 'scholarship', 'company'];
const STOP_VALUES: readonly OpportunityStopReason[] = [
  'no_verified_host', 'missing_configuration', 'missing_research_interests', 'provider_failure', 'no_results',
  'unverified_result_host', 'page_fetch_failed', 'page_fetch_budget', 'country_not_confirmed', 'no_interest_match',
  'invalid_official_record', 'duplicate_source', 'duplicate_identity', 'saved',
];

/** Rebuilds a run from fixed enums, bounded names, and nonnegative counters before persistence. */
export function sanitizeOpportunityDiscoveryRun(value: OpportunityDiscoveryRun): OpportunityDiscoveryRun {
  if (value.system !== 'opportunity' || value.trigger !== 'manual' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id) ||
      !Number.isFinite(Date.parse(value.startedAt)) || (value.completedAt !== undefined && !Number.isFinite(Date.parse(value.completedAt))) ||
      !['running', 'completed', 'partial', 'failed'].includes(value.state)) throw new Error('Invalid opportunity discovery run');
  const countKeys = ['searches', 'results', 'pagesFetched', 'interestMatches', 'saved', 'duplicates', 'rejected', 'failures'] as const;
  const counts = Object.fromEntries(countKeys.map((key) => {
    const count = value.counts[key];
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error('Invalid opportunity discovery count');
    return [key, count];
  })) as OpportunityDiscoveryRun['counts'];
  const countries = value.countries.slice(0, OPPORTUNITY_DISCOVERY_LIMITS.countriesPerRun);
  if (!countries.every((country) => typeof country === 'string' && country.trim() && country.length <= 80)) throw new Error('Invalid opportunity discovery country');
  const sources = value.sources.slice(0, OPPORTUNITY_DISCOVERY_LIMITS.countriesPerRun * OPPORTUNITY_DISCOVERY_LIMITS.sourcesPerCountry).map((source) => {
    if (!source.country.trim() || source.country.length > 80 || !SOURCE_VALUES.includes(source.source) ||
        !['completed', 'failed', 'skipped'].includes(source.state)) throw new Error('Invalid opportunity source outcome');
    const bounded = Object.fromEntries(countKeys.map((key) => {
      const count = source.counts[key];
      if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error('Invalid opportunity source count');
      return [key, count];
    })) as OpportunitySourceRun['counts'];
    const hosts = source.hosts.slice(0, 8).filter((host) => /^[a-z0-9.-]{1,253}$/.test(host));
    const stopReasons = [...new Set(source.stopReasons.filter((reason) => STOP_VALUES.includes(reason)))].slice(0, 8);
    return { country: source.country, source: source.source, hosts, state: source.state, counts: bounded, stopReasons };
  });
  const stopReasons = [...new Set(value.stopReasons.filter((reason) => STOP_VALUES.includes(reason)))].slice(0, 12);
  return {
    system: 'opportunity', id: value.id, trigger: 'manual', startedAt: value.startedAt,
    ...(value.completedAt ? { completedAt: value.completedAt } : {}), countries, state: value.state,
    counts, sources, stopReasons,
  };
}
