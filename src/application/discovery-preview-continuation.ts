import type { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
type DiscoveryRegion = keyof typeof OFFICIAL_HOSTS_BY_REGION;

export interface PreviewContinuationPlan {
  anchorFound: boolean;
  attemptedCountries: string[];
  skipped: Array<{ country: string; reason: 'no_verified_official_hosts' | 'already_tested_no_retry' }>;
  batches: DiscoveryRegion[][];
}

/** Builds saved-order batches after an anchor and excludes every country with a recorded attempt. */
export function planDiscoveryPreviewContinuation(input: {
  countries: string[];
  afterCountry?: string;
  verifiedHosts: Record<string, readonly string[] | undefined>;
  attemptedCountries: Iterable<string>;
  batchSize?: number;
}): PreviewContinuationPlan {
  const anchorIndex = input.afterCountry ? input.countries.indexOf(input.afterCountry) : -1;
  if (input.afterCountry && anchorIndex < 0) return { anchorFound: false, attemptedCountries: [], skipped: [], batches: [] };
  const batchSize = input.batchSize ?? 5;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5) throw new Error('batchSize must be from 1 through 5');
  const attempted = new Set(input.attemptedCountries);
  const skipped: PreviewContinuationPlan['skipped'] = [];
  const eligible: DiscoveryRegion[] = [];
  for (const country of input.countries.slice(anchorIndex + 1)) {
    if (!input.verifiedHosts[country]?.length) {
      skipped.push({ country, reason: 'no_verified_official_hosts' });
    } else if (attempted.has(country)) {
      skipped.push({ country, reason: 'already_tested_no_retry' });
    } else {
      eligible.push(country as DiscoveryRegion);
    }
  }
  const batches: DiscoveryRegion[][] = [];
  for (let offset = 0; offset < eligible.length; offset += batchSize) batches.push(eligible.slice(offset, offset + batchSize));
  return { anchorFound: true, attemptedCountries: eligible, skipped, batches };
}
