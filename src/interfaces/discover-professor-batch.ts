import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { discoverProfessorCandidates, fetchOfficialPage } from '../application/research-discovery.ts';
import { persistPreparedProfessorEvidence, prepareSavedProfessorEvidence } from '../application/professor-research-evidence.ts';
import { nextVerifiedTargetCountries } from '../domain/discovery-country-coverage.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { COUNTRY_CODES_BY_REGION } from './discover-professor-candidates.ts';
import { BraveSearchProvider, isVerifiedBraveCountryCode, type SearchOptions, type SearchProvider } from '../infrastructure/brave-search-provider.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { appendPhase3ResultDiagnostic } from '../infrastructure/phase3-pilot-diagnostics.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

export interface DiscoveryBatchOptions {
  afterCountry?: string;
  skipCountries: string[];
}

export function requestedBatchOptions(args: readonly string[]): DiscoveryBatchOptions {
  let afterCountry: string | undefined;
  const skipCountries: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--after' || argument === '--skip') {
      const value = args[++index];
      if (!value || value.startsWith('--') || !value.trim()) throw new Error(`${argument} requires a country name`);
      if (argument === '--after') {
        if (afterCountry !== undefined) throw new Error('Specify --after only once');
        afterCountry = value.trim();
      } else {
        if (skipCountries.includes(value.trim())) throw new Error('Specify each --skip country only once');
        skipCountries.push(value.trim());
      }
    } else if (argument.startsWith('--after=')) {
      const value = argument.slice('--after='.length).trim();
      if (afterCountry !== undefined) throw new Error('Specify --after only once');
      if (!value) throw new Error('--after requires a verified country name');
      afterCountry = value;
    } else if (argument.startsWith('--skip=')) {
      const value = argument.slice('--skip='.length).trim();
      if (!value) throw new Error('--skip requires a country name');
      if (skipCountries.includes(value)) throw new Error('Specify each --skip country only once');
      skipCountries.push(value);
    } else {
      // Never let a shell that stripped the flag turn a continuation into the first batch.
      throw new Error('Unexpected discovery batch argument');
    }
  }
  return { ...(afterCountry ? { afterCountry } : {}), skipCountries };
}

export async function runFiveCountryProfessorBatch(options: DiscoveryBatchOptions = { skipCountries: [] }): Promise<void> {
  let storage: Awaited<ReturnType<typeof connectMongoStorage>> | undefined;
  try {
    storage = await connectMongoStorage();
    const profile = await storage.repositories.profiles.get('primary');
    if (!profile) throw new Error('profile_unavailable');
    const verifiedCountries = nextVerifiedTargetCountries(profile.applicant.target.countries, OFFICIAL_HOSTS_BY_REGION, undefined, 45);
    const countries = nextVerifiedTargetCountries(profile.applicant.target.countries, OFFICIAL_HOSTS_BY_REGION,
      options.afterCountry, 5, options.skipCountries);
    if (!countries.length) {
      process.stdout.write(`${JSON.stringify({
        attemptedCountries: [], requests: 0, resultCount: 0, saved: 0, preparedEvidence: 0,
        duplicates: 0, rejected: 0, officialPageFetchFailures: 0, searchFailures: [],
        countriesRemaining: [], skippedAttemptedCountries: options.skipCountries,
        uncoveredCountries: profile.applicant.target.countries.filter((country) => !OFFICIAL_HOSTS_BY_REGION[country as keyof typeof OFFICIAL_HOSTS_BY_REGION]),
      })}\n`);
      return;
    }
    const interests = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields];
    if (!interests.some((interest) => interest.trim())) throw new Error('no_saved_research_interests');

    // Read the complete duplicate set before the first provider call.
    const existing = await storage.repositories.candidates.list();
    const existingIds = new Set(existing.map((candidate) => candidate.id));
    const attemptedCountries: string[] = [];
    const searchFailures: Array<{ country: string; kind: string }> = [];
    const baseProvider = new BraveSearchProvider();
    const provider: SearchProvider = {
      async search(query: string, options?: SearchOptions) {
        const country = options?.region;
        const expectedCode = country ? COUNTRY_CODES_BY_REGION[country as keyof typeof COUNTRY_CODES_BY_REGION] : undefined;
        const expectedMode = isVerifiedBraveCountryCode(expectedCode) ? 'api_country' : 'query_and_host';
        if (!country || !countries.includes(country) || attemptedCountries.includes(country) || options?.targetingMode !== expectedMode ||
            (expectedMode === 'api_country' ? options?.countryCode !== expectedCode : options?.countryCode !== undefined)) {
          throw new Error('unexpected_search_scope');
        }
        attemptedCountries.push(country);
        try { return await baseProvider.search(query, { ...options, count: 3 }); }
        catch (error) {
          const failure = safeFailureRecord(error);
          searchFailures.push({ country, kind: failure.kind });
          await appendPhase3ResultDiagnostic({
            stage: 'brave_search', country, hostname: null, outcome: 'search_failed',
            targetingMode: expectedMode,
            rejectionReasons: [failure.kind],
            ...(failure.statusCode ? { statusCode: failure.statusCode } : {}),
            ...(failure.errorName ? { errorName: failure.errorName } : {}),
            ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
            ...(failure.causeName ? { causeName: failure.causeName } : {}),
            ...(failure.causeCode ? { causeCode: failure.causeCode } : {}),
            ...(failure.braveErrorCode ? { braveErrorCode: failure.braveErrorCode } : {}),
            ...(failure.braveErrorId ? { braveErrorId: failure.braveErrorId } : {}),
            ...(failure.requestId ? { requestId: failure.requestId } : {}),
            ...(failure.redirectDestinationHost ? { redirectDestinationHost: failure.redirectDestinationHost } : {}),
            ...(failure.redirectDestinationPath ? { redirectDestinationPath: failure.redirectDestinationPath } : {}),
          });
          return [];
        }
      },
    };
    const hosts: Record<string, string[]> = Object.fromEntries(countries.map((country) => [country, Array.from(OFFICIAL_HOSTS_BY_REGION[country as keyof typeof OFFICIAL_HOSTS_BY_REGION])]));
    const hostCodes = Object.fromEntries(countries.map((country) => [country, COUNTRY_CODES_BY_REGION[country as keyof typeof COUNTRY_CODES_BY_REGION]]));
    const result = await discoverProfessorCandidates({
      profile,
      provider,
      repository: storage.repositories.candidates,
      options: {
        officialHostsByRegion: hosts,
        countryCodesByRegion: hostCodes,
        oneSearchPerRegion: true,
        oneQueryPerRegion: true,
        maxSearches: countries.length,
        resultsPerQuery: 3,
        saveOnlyProfessorProfiles: true,
        shouldSaveCandidate: (candidate) => prepareSavedProfessorEvidence({ candidate, researchInterests: interests, checkedAt: new Date().toISOString() }).recommendation === 'likely relevant',
        onSearchTargeting: ({ country, mode }) => appendPhase3ResultDiagnostic({
          stage: 'brave_search', country, hostname: null, outcome: 'search_started', rejectionReasons: [], targetingMode: mode,
        }),
        onResultDiagnostic: (diagnostic) => appendPhase3ResultDiagnostic(diagnostic),
        fetchPage: (url) => {
          const hostname = new URL(url).hostname;
          const countryEntry = Object.entries(hosts).find(([, countryHosts]) => countryHosts.includes(hostname));
          const allowedHosts = countryEntry?.[1] ?? [];
          return fetchOfficialPage(url, allowedHosts, fetch, async (statusCode, redirectDestinationHost, redirectDestinationPath) => {
            await appendPhase3ResultDiagnostic({
              stage: 'official_page_fetch', country: countryEntry?.[0] ?? 'Unknown', hostname, outcome: 'redirect_followed',
              rejectionReasons: [], statusCode, redirectDestinationHost, redirectDestinationPath,
            });
          });
        },
      },
    });
    const fresh = (await storage.repositories.candidates.list()).filter((candidate) =>
      !existingIds.has(candidate.id) && countries.includes(candidate.searchRegion || candidate.country) && candidate.leadType === 'professor_profile',
    );
    const checkedAt = new Date().toISOString();
    const prepared = await persistPreparedProfessorEvidence({
      candidates: fresh,
      researchInterests: interests,
      checkedAt,
      runId: `manual-batch:${checkedAt}:${randomUUID()}`,
      repository: storage.repositories.discoveryChecks,
    });
    const lastCountryIndex = verifiedCountries.indexOf(countries.at(-1)!);
    const skippedCountries = new Set(options.skipCountries);
    process.stdout.write(`${JSON.stringify({
      attemptedCountries,
      targetingModes: attemptedCountries.map((country) => ({ country, mode: isVerifiedBraveCountryCode(COUNTRY_CODES_BY_REGION[country as keyof typeof COUNTRY_CODES_BY_REGION]) ? 'api_country' : 'query_and_host' })),
      requests: result.searches,
      resultCount: result.saved + result.duplicates + result.rejected + result.officialPageFetchFailures,
      saved: result.saved,
      preparedEvidence: prepared.length,
      duplicates: result.duplicates,
      rejected: result.rejected,
      officialPageFetchFailures: result.officialPageFetchFailures,
      searchFailures,
      countriesRemaining: verifiedCountries.slice(lastCountryIndex + 1).filter((country) => !skippedCountries.has(country)),
      skippedAttemptedCountries: options.skipCountries,
      uncoveredCountries: profile.applicant.target.countries.filter((country) => !OFFICIAL_HOSTS_BY_REGION[country as keyof typeof OFFICIAL_HOSTS_BY_REGION]),
    })}\n`);
  } catch (error) {
    const failure = safeFailureRecord(error);
    process.stderr.write(`${JSON.stringify({ ok: false, kind: failure.kind, errorName: failure.errorName, code: failure.errorCode })}\n`);
    process.exitCode = 1;
  } finally {
    try { await storage?.close(); } catch { /* Keep operation reporting independent from client shutdown. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runFiveCountryProfessorBatch(requestedBatchOptions(process.argv.slice(2)));
}
