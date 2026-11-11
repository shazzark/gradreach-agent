import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';

export interface DiscoveryCountryCoverage {
  country: string;
  status: 'verified' | 'uncovered';
  officialHosts: readonly string[];
  message: string;
}

export function discoveryCountryCoverage(countries: string[]): DiscoveryCountryCoverage[] {
  return countries.map((country) => {
    const officialHosts = OFFICIAL_HOSTS_BY_REGION[country as keyof typeof OFFICIAL_HOSTS_BY_REGION] ?? [];
    return officialHosts.length
      ? { country, status: 'verified', officialHosts, message: 'Verified official host available.' }
      : { country, status: 'uncovered', officialHosts, message: 'Skipped until an official university host is verified.' };
  });
}

export function firstVerifiedTargetCountries(countries: string[], verifiedHosts: Record<string, readonly string[]>, limit = 5): string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 45) throw new Error('limit must be an integer from 1 through 45');
  return [...new Set(countries.map((country) => country.trim()).filter(Boolean))]
    .filter((country) => Boolean(verifiedHosts[country]?.length))
    .slice(0, limit);
}

/** Selects the next bounded batch after a country already completed or attempted. */
export function nextVerifiedTargetCountries(
  countries: string[],
  verifiedHosts: Record<string, readonly string[]>,
  afterCountry?: string,
  limit = 5,
  excludedCountries: readonly string[] = [],
): string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 45) throw new Error('limit must be an integer from 1 through 45');
  const ordered = [...new Set(countries.map((country) => country.trim()).filter(Boolean))]
    .filter((country) => Boolean(verifiedHosts[country]?.length));
  const cursor = afterCountry === undefined ? -1 : ordered.indexOf(afterCountry.trim());
  if (afterCountry !== undefined && cursor < 0) throw new Error('afterCountry must be a configured country with a verified host');
  const excluded = new Set(excludedCountries.map((country) => country.trim()));
  return ordered.slice(cursor + 1).filter((country) => !excluded.has(country)).slice(0, limit);
}
