import { createHash } from 'node:crypto';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { DiscoveryEvidence, ProfessorCandidate } from '../domain/outreach-queue.ts';
import type { SearchProvider, SearchResult } from '../infrastructure/brave-search-provider.ts';

const PUBLIC_SUFFIXES = new Set([
  'com', 'edu', 'gov', 'mil', 'net', 'org',
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'org.uk', 'plc.uk', 'sch.uk',
  'ac.jp', 'co.jp', 'go.jp', 'or.jp', 'com.au', 'edu.au', 'gov.au', 'net.au', 'org.au',
  'ac.nz', 'co.nz', 'govt.nz', 'net.nz', 'org.nz', 'com.br', 'edu.br', 'gov.br', 'org.br',
  'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn', 'ac.in', 'co.in', 'edu.in', 'gov.in', 'net.in', 'org.in',
]);

export interface CandidateDiscoveryRepository {
  save(candidate: ProfessorCandidate): Promise<void>;
}

export interface DiscoveryOptions {
  /** Explicitly reviewed official institutional hostnames, keyed by configured profile country. */
  officialHostsByRegion: Record<string, string[]>;
  countryCodesByRegion?: Record<string, string>;
  resultsPerQuery?: number;
  now?: () => Date;
}

function normalizeHost(value: string): string {
  const host = value.toLowerCase().trim().replace(/^\.+|\.+$/g, '');
  const labels = host.split('.');
  if (!host || host.includes('/') || host.includes(':') || host.includes('@') ||
      labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      PUBLIC_SUFFIXES.has(host)) {
    throw new Error(`Invalid or overly broad official host: ${value}`);
  }
  return host;
}

function isAllowedOfficialUrl(value: string, hosts: string[]): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    // Exact host matching avoids implicitly trusting every tenant under a broad suffix.
    return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(hostname);
  } catch {
    return false;
  }
}

function canonicalizeSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|ref|source)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function queryFor(region: string, interest: string, host: string): string {
  return `site:${host} professor ${interest} MSc ${region}`.slice(0, 600);
}

function candidateFor(result: SearchResult, sourceUrl: string, region: string, query: string, retrievedAt: string): ProfessorCandidate {
  const id = `discovery-${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 24)}`;
  const evidence: DiscoveryEvidence = {
    sourceUrl,
    excerpt: result.excerpt.slice(0, 1200),
    retrievedAt,
    verification: 'unverified',
    region,
    query,
  };
  return {
    id,
    // Search titles are leads, not confirmed people; review status and evidence label preserve that distinction.
    name: result.title || 'Unreviewed search result',
    institution: new URL(sourceUrl).hostname,
    country: region,
    sourceCheckedAt: retrievedAt,
    discoveryEvidence: [evidence],
    status: 'needs-evidence',
    approvedForSending: false,
    priority: 0,
  };
}

/** Searches every configured country and reviewed institution host, persisting only review-gated leads. */
export async function discoverProfessorCandidates(input: {
  profile: ApplicantProfile;
  provider: SearchProvider;
  repository: CandidateDiscoveryRepository;
  options: DiscoveryOptions;
}): Promise<{ searches: number; saved: number; rejected: number }> {
  const regions = [...new Set(input.profile.applicant.target.countries.map((country) => country.trim()).filter(Boolean))];
  if (regions.length === 0) throw new Error('At least one configured target country is required for discovery');
  const interests = [...new Set([...input.profile.applicant.target.fields, ...input.profile.applicant.target.researchInterests]
    .map((item) => item.trim()).filter(Boolean))];
  if (interests.length === 0) throw new Error('At least one configured academic field or research interest is required');

  let searches = 0;
  let saved = 0;
  let rejected = 0;
  const seenUrls = new Set<string>();
  for (const region of regions) {
    const configuredHosts = input.options.officialHostsByRegion[region];
    if (!configuredHosts?.length) throw new Error(`No reviewed official institution hosts configured for region: ${region}`);
    const hosts = [...new Set(configuredHosts.map(normalizeHost))];
    for (const host of hosts) {
      for (const interest of interests) {
        const query = queryFor(region, interest, host);
        const results = await input.provider.search(query, {
          ...(input.options.countryCodesByRegion?.[region] ? { countryCode: input.options.countryCodesByRegion[region] } : {}),
          count: input.options.resultsPerQuery ?? 10,
        });
        searches += 1;
        const retrievedAt = (input.options.now?.() ?? new Date()).toISOString();
        for (const result of results) {
          if (!isAllowedOfficialUrl(result.url, hosts) || !result.title.trim() || !result.excerpt.trim()) {
            rejected += 1;
            continue;
          }
          const canonicalUrl = canonicalizeSourceUrl(result.url);
          if (seenUrls.has(canonicalUrl)) continue;
          seenUrls.add(canonicalUrl);
          await input.repository.save(candidateFor(result, canonicalUrl, region, query, retrievedAt));
          saved += 1;
        }
      }
    }
  }
  return { searches, saved, rejected };
}
