import '../infrastructure/local-env.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import { randomUUID } from 'node:crypto';
import type { DiscoveryResultDiagnostic, DiscoveryRun } from '../application/automatic-discovery.ts';
import {
  discoverProfessorCandidates,
  fetchOfficialPage,
  type CandidateDiscoveryRepository,
  type DiscoveryOptions,
} from '../application/research-discovery.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { appendPhase3ResultDiagnostic, storedDiscoveryResultDiagnostic, type Phase3ResultDiagnostic } from '../infrastructure/phase3-pilot-diagnostics.ts';
import { BraveSearchProvider, isVerifiedBraveCountryCode, type SearchProvider } from '../infrastructure/brave-search-provider.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord, SanitizedIntegrationError } from '../infrastructure/sanitized-failure.ts';
import { prepareSavedProfessorEvidence } from '../application/professor-research-evidence.ts';

export type DiscoveryRegion = keyof typeof OFFICIAL_HOSTS_BY_REGION;

export const COUNTRY_CODES_BY_REGION: Record<DiscoveryRegion, string> = {
  Belgium: 'BE',
  Australia: 'AU',
  Canada: 'CA',
  China: 'CN',
  Italy: 'IT',
  Japan: 'JP',
  'New Zealand': 'NZ',
  'South Korea': 'KR',
  Switzerland: 'CH',
  Portugal: 'PT',
  'United States': 'US',
  'Bosnia and Herzegovina': 'BA', Bulgaria: 'BG', Croatia: 'HR', Czechia: 'CZ', Denmark: 'DK', Estonia: 'EE',
  Finland: 'FI', France: 'FR', Germany: 'DE', Greece: 'GR', Hungary: 'HU', Iceland: 'IS', Ireland: 'IE', Latvia: 'LV',
  Liechtenstein: 'LI', Lithuania: 'LT', Luxembourg: 'LU', Malta: 'MT', Moldova: 'MD', Montenegro: 'ME', Netherlands: 'NL',
  Norway: 'NO', Poland: 'PL', Russia: 'RU', Serbia: 'RS', Slovakia: 'SK', Slovenia: 'SI', Spain: 'ES', Sweden: 'SE',
  Ukraine: 'UA', 'United Kingdom': 'GB',
};

export type DiscoveryRunnerStage =
  | 'mongodb_connect'
  | 'pilot_configuration'
  | 'profile_load'
  | 'candidate_read'
  | 'brave_search'
  | 'official_page_fetch'
  | 'candidate_save'
  | 'local_diagnostic_write';

interface DiscoveryRunnerStorage {
  repositories: {
    candidates: CandidateDiscoveryRepository;
    profiles: { get(profileId: string): Promise<ApplicantProfile | undefined> };
    discoveryRuns: {
      claim(run: DiscoveryRun): Promise<boolean>;
      finish(run: DiscoveryRun): Promise<void>;
    };
  };
  close(): Promise<void>;
}

export interface DiscoveryRunnerInput {
  connect?: () => Promise<DiscoveryRunnerStorage>;
  loadProfile?: () => Promise<ApplicantProfile>;
  provider?: SearchProvider;
  fetchPage?: DiscoveryOptions['fetchPage'];
  recordDiagnostic?: (diagnostic: Phase3ResultDiagnostic) => Promise<void>;
  onStage?: (stage: DiscoveryRunnerStage) => void;
}

export async function runDiscoveryPilot(region: DiscoveryRegion, input: DiscoveryRunnerInput = {}) {
  const onStage = input.onStage ?? (() => {});
  onStage('mongodb_connect');
  const storage = await (input.connect ?? connectMongoStorage)();
  try {
    onStage('profile_load');
    const loadedProfile = input.loadProfile
      ? await input.loadProfile()
      : await storage.repositories.profiles.get('primary');
    if (!loadedProfile) throw new SanitizedIntegrationError('missing_configuration');
    if (!loadedProfile.applicant.target.countries.includes(region)) {
      throw new SanitizedIntegrationError('invalid_request');
    }
    const profile = {
      ...loadedProfile,
      applicant: {
        ...loadedProfile.applicant,
        target: { ...loadedProfile.applicant.target, countries: [region] },
      },
    };
    const researchInterests = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields];

    const repository: CandidateDiscoveryRepository = {
      async list() {
        onStage('candidate_read');
        return storage.repositories.candidates.list();
      },
      async save(candidate) {
        onStage('candidate_save');
        await storage.repositories.candidates.save(candidate);
      },
    };
    const baseProvider = input.provider ?? new BraveSearchProvider();
    const provider: SearchProvider = {
      async search(query, options) {
        onStage('brave_search');
        return baseProvider.search(query, options);
      },
    };
    const fetchPage: NonNullable<DiscoveryOptions['fetchPage']> = async (url) => {
      onStage('official_page_fetch');
      return input.fetchPage
        ? input.fetchPage(url)
        : fetchOfficialPage(url, [...OFFICIAL_HOSTS_BY_REGION[region]], fetch, async (statusCode, redirectDestinationHost, redirectDestinationPath) => {
          onStage('local_diagnostic_write');
          await (input.recordDiagnostic ?? appendPhase3ResultDiagnostic)({
            stage: 'official_page_fetch', country: region, hostname: new URL(url).hostname.toLowerCase(),
            outcome: 'redirect_followed', rejectionReasons: [], statusCode, redirectDestinationHost, redirectDestinationPath,
          });
        });
    };
    const recordDiagnostic = input.recordDiagnostic ?? appendPhase3ResultDiagnostic;
    const startedAt = new Date().toISOString();
    const run: DiscoveryRun = {
      id: `manual-pilot:${startedAt}:${randomUUID()}`,
      scheduledFor: startedAt,
      startedAt,
      country: region,
      state: 'running',
      counts: { searches: 0, results: 0, saved: 0, duplicates: 0, rejections: 0, fetchFailures: 0, inspected: 0, inspectionFailures: 0 },
    };
    if (!await storage.repositories.discoveryRuns.claim(run)) throw new Error('discovery_run_claim_failed');
    const resultDiagnostics: DiscoveryResultDiagnostic[] = [];
    const recordPilotDiagnostic = async (diagnostic: Phase3ResultDiagnostic) => {
      if (diagnostic.outcome !== 'search_started' && diagnostic.outcome !== 'redirect_followed' && resultDiagnostics.length < 3) {
        const resultNumber = diagnostic.resultNumber ?? resultDiagnostics.length + 1;
        const safeDiagnostic = storedDiscoveryResultDiagnostic(diagnostic, resultNumber);
        if (safeDiagnostic && !resultDiagnostics.some((item) => item.resultNumber === safeDiagnostic.resultNumber)) {
          resultDiagnostics.push(safeDiagnostic);
          resultDiagnostics.sort((left, right) => left.resultNumber - right.resultNumber);
        }
      }
      await recordDiagnostic(diagnostic);
    };

    let result: Awaited<ReturnType<typeof discoverProfessorCandidates>>;
    try {
      result = await discoverProfessorCandidates({
        profile,
        provider,
        repository,
        options: {
        officialHostsByRegion: { [region]: [...OFFICIAL_HOSTS_BY_REGION[region]] },
        countryCodesByRegion: { [region]: COUNTRY_CODES_BY_REGION[region] },
        resultsPerQuery: 3,
        oneSearchPerRegion: true,
        maxSearches: 1,
        saveOnlyProfessorProfiles: true,
        shouldSaveCandidate: (candidate) => prepareSavedProfessorEvidence({
          candidate,
          researchInterests,
          checkedAt: new Date().toISOString(),
        }).recommendation === 'likely relevant',
        onSearchTargeting: async ({ country, mode }) => {
          onStage('local_diagnostic_write');
          await recordPilotDiagnostic({ stage: 'brave_search', country, hostname: null, outcome: 'search_started', rejectionReasons: [], targetingMode: mode });
        },
        fetchPage,
        onResultDiagnostic: async (diagnostic) => {
          onStage('local_diagnostic_write');
          await recordPilotDiagnostic(diagnostic);
        },
      },
      });
    } catch (error) {
      const failure = safeFailureRecord(error);
      await storage.repositories.discoveryRuns.finish({
        ...run,
        state: 'failed',
        completedAt: new Date().toISOString(),
        failureCode: failure.kind,
        resultDiagnostics,
      });
      throw error;
    }
    const counts: DiscoveryRun['counts'] = {
      ...run.counts,
      searches: result.searches,
      results: result.saved + result.duplicates + result.rejected + result.officialPageFetchFailures,
      saved: result.saved,
      duplicates: result.duplicates,
      rejections: result.rejected,
      fetchFailures: result.officialPageFetchFailures,
    };
    const completedRun: DiscoveryRun = {
      ...run,
      state: 'completed',
      completedAt: new Date().toISOString(),
      targetingMode: isVerifiedBraveCountryCode(COUNTRY_CODES_BY_REGION[region]) ? 'api_country' : 'query_and_host',
      counts,
      resultDiagnostics,
    };
    await storage.repositories.discoveryRuns.finish(completedRun);
    return { ...result, targetingMode: completedRun.targetingMode, resultDiagnostics };
  } finally {
    try { await storage.close(); } catch { /* Do not replace the discovery result with a shutdown error. */ }
  }
}

export function runSouthKoreaProfessorPilot(input: DiscoveryRunnerInput = {}) {
  return runDiscoveryPilot('South Korea', input);
}

export function discoveryPilotSummary(region: DiscoveryRegion, result: Awaited<ReturnType<typeof runDiscoveryPilot>>) {
  return {
    ok: true,
    region,
    searches: result.searches,
    results: result.saved + result.duplicates + result.rejected + result.officialPageFetchFailures,
    targetingMode: result.targetingMode,
    saved: result.saved,
    duplicates: result.duplicates,
    rejected: result.rejected,
    validationRejections: result.validationRejections,
    officialPageFetchFailures: result.officialPageFetchFailures,
    poolSize: result.poolSize,
    resultDiagnostics: result.resultDiagnostics,
  };
}

export function requestedDiscoveryRegion(args: readonly string[]): DiscoveryRegion | undefined {
  const regionFlag = args.findIndex((argument) => argument === '--region');
  const value = regionFlag >= 0
    ? args[regionFlag + 1]
    : args.find((argument) => argument.startsWith('--region='))?.slice('--region='.length);
  return value && Object.hasOwn(OFFICIAL_HOSTS_BY_REGION, value) ? value as DiscoveryRegion : undefined;
}

export async function runRequestedDiscoveryPilot(
  args: readonly string[],
  runner: (region: DiscoveryRegion) => Promise<unknown> = runDiscoveryPilot,
): Promise<unknown> {
  const region = requestedDiscoveryRegion(args);
  if (!region) throw new SanitizedIntegrationError('invalid_request');
  return runner(region);
}

async function run(): Promise<void> {
  let stage: DiscoveryRunnerStage = 'pilot_configuration';
  try {
    const region = requestedDiscoveryRegion(process.argv.slice(2));
    if (!region) throw new SanitizedIntegrationError('invalid_request');
    const result = await runDiscoveryPilot(region, { onStage: (current) => { stage = current; } });
    process.stdout.write(`${JSON.stringify(discoveryPilotSummary(region, result))}\n`);
  } catch (error) {
    const failure = safeFailureRecord(error);
    process.stderr.write(`${JSON.stringify({
      ok: false,
      stage,
      kind: failure.kind,
      ...(failure.errorName ? { errorName: failure.errorName } : {}),
      ...(failure.codeName ? { codeName: failure.codeName } : {}),
      ...(failure.errorCode ? { code: failure.errorCode } : {}),
      ...(failure.causeName ? { causeName: failure.causeName } : {}),
      ...(failure.causeCode ? { causeCode: failure.causeCode } : {}),
      ...(failure.braveErrorCode ? { braveErrorCode: failure.braveErrorCode } : {}),
      ...(failure.braveErrorId ? { braveErrorId: failure.braveErrorId } : {}),
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
      ...(failure.syscall ? { syscall: failure.syscall } : {}),
      ...(failure.serverStates ? { serverStates: failure.serverStates } : {}),
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
