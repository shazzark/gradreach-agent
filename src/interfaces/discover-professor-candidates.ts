import '../infrastructure/local-env.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import {
  discoverProfessorCandidates,
  fetchOfficialPage,
  type CandidateDiscoveryRepository,
  type DiscoveryOptions,
} from '../application/research-discovery.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { loadApplicantProfile } from '../infrastructure/local-profile.ts';
import { appendPhase3ResultDiagnostic, type Phase3ResultDiagnostic } from '../infrastructure/phase3-pilot-diagnostics.ts';
import { BraveSearchProvider, type SearchProvider } from '../infrastructure/brave-search-provider.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

export type DiscoveryRunnerStage =
  | 'mongodb_connect'
  | 'profile_load'
  | 'candidate_read'
  | 'brave_search'
  | 'official_page_fetch'
  | 'candidate_save'
  | 'local_diagnostic_write';

interface DiscoveryRunnerStorage {
  repositories: { candidates: CandidateDiscoveryRepository };
  close(): Promise<void>;
}

export async function runSouthKoreaProfessorPilot(input: {
  connect?: () => Promise<DiscoveryRunnerStorage>;
  loadProfile?: () => Promise<ApplicantProfile>;
  provider?: SearchProvider;
  fetchPage?: DiscoveryOptions['fetchPage'];
  recordDiagnostic?: (diagnostic: Phase3ResultDiagnostic) => Promise<void>;
  onStage?: (stage: DiscoveryRunnerStage) => void;
} = {}) {
  const onStage = input.onStage ?? (() => {});
  onStage('mongodb_connect');
  const storage = await (input.connect ?? connectMongoStorage)();
  try {
    onStage('profile_load');
    const loadedProfile = await (input.loadProfile ?? loadApplicantProfile)();
    const profile = {
      ...loadedProfile,
      applicant: {
        ...loadedProfile.applicant,
        target: { ...loadedProfile.applicant.target, countries: ['South Korea'] },
      },
    };

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
        : fetchOfficialPage(url, [...OFFICIAL_HOSTS_BY_REGION['South Korea']]);
    };
    const recordDiagnostic = input.recordDiagnostic ?? appendPhase3ResultDiagnostic;

    return await discoverProfessorCandidates({
      profile,
      provider,
      repository,
      options: {
        officialHostsByRegion: { 'South Korea': [...OFFICIAL_HOSTS_BY_REGION['South Korea']] },
        countryCodesByRegion: { 'South Korea': 'KR' },
        resultsPerQuery: 3,
        oneSearchPerRegion: true,
        maxSearches: 1,
        saveOnlyProfessorProfiles: true,
        fetchPage,
        onResultDiagnostic: async (diagnostic) => {
          onStage('local_diagnostic_write');
          await recordDiagnostic(diagnostic);
        },
      },
    });
  } finally {
    try { await storage.close(); } catch { /* Do not replace the discovery result with a shutdown error. */ }
  }
}

async function run(): Promise<void> {
  let stage: DiscoveryRunnerStage = 'mongodb_connect';
  try {
    const result = await runSouthKoreaProfessorPilot({ onStage: (current) => { stage = current; } });
    process.stdout.write(`${JSON.stringify({ ok: true, searches: result.searches, saved: result.saved, rejected: result.rejected, poolSize: result.poolSize })}\n`);
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
      ...(failure.syscall ? { syscall: failure.syscall } : {}),
      ...(failure.serverStates ? { serverStates: failure.serverStates } : {}),
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
