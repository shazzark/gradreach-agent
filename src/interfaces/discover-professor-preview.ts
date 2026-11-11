import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverProfessorCandidates, fetchOfficialPage, MAX_OFFICIAL_PAGE_FETCHES_PER_RUN, type CandidatePreviewOutcome, type CandidatePreviewReason, type DiscoveryOptions } from '../application/research-discovery.ts';
import { prepareSavedProfessorEvidence } from '../application/professor-research-evidence.ts';
import { OFFICIAL_HOSTS_BY_REGION, OFFICIAL_INSTITUTION_BY_REGION } from '../config/official-host-allowlist.ts';
import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { COUNTRY_CODES_BY_REGION, requestedDiscoveryRegion, type DiscoveryRegion } from './discover-professor-candidates.ts';
import { BraveSearchProvider, type SearchProvider } from '../infrastructure/brave-search-provider.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';

export interface DiscoveryPreviewReport {
  generatedAt: string;
  region: DiscoveryRegion;
  institution: string;
  status: 'completed' | 'failed';
  searches: number;
  searchStrategies: readonly (typeof DISCOVERY_PREVIEW_QUERY_TYPES)[number][];
  searchCoverage: 'complete' | 'incomplete' | 'failed';
  coverageStopReasons: string[];
  budget: DiscoveryPreviewBudget;
  results: number;
  pageFetches: number;
  passed: number;
  stopped: number;
  duplicates: number;
  reasonCounts: Partial<Record<CandidatePreviewReason, number>>;
  failureCode?: string;
  candidates: Array<{
    recordId: string;
    name: string;
    identityVerified: boolean;
    institution: string;
    outcome: 'passed' | 'stopped';
    reason: CandidatePreviewReason;
    interestMatch: 'matched' | 'not_matched' | 'not_evaluated';
    matchExplanation: string;
    reviewStatus: 'awaiting_owner_review';
    approved: false;
    queued: false;
    sent: false;
    officialProfileSource?: string;
    researchSources: Array<{ url: string; supportingEvidence: string }>;
  }>;
}

export interface DiscoveryPreviewBudget {
  maxSearchRequestsPerCountry: number;
  resultsPerSearch: number;
  maxPagesPerQuery: number;
  maxPageFetchesPerCountry: number;
  minimumRequestIntervalMs: number;
}

export const DEFAULT_DISCOVERY_PREVIEW_BUDGET: DiscoveryPreviewBudget = {
  maxSearchRequestsPerCountry: 8,
  resultsPerSearch: 20,
  maxPagesPerQuery: 2,
  maxPageFetchesPerCountry: MAX_OFFICIAL_PAGE_FETCHES_PER_RUN,
  minimumRequestIntervalMs: 1_050,
};

export const DISCOVERY_PREVIEW_QUERY_TYPES = ['faculty_directory', 'professor_profile', 'research_group', 'research_topic'] as const;

interface PreviewStorage {
  repositories: {
    profiles: { get(profileId: string): Promise<ApplicantProfile | undefined> };
    candidates: { list(): Promise<ProfessorCandidate[]> };
  };
  close(): Promise<void>;
}

export interface DiscoveryPreviewInput {
  connect?: () => Promise<PreviewStorage>;
  provider?: SearchProvider;
  fetchPage?: DiscoveryOptions['fetchPage'];
  maxPageFetchesPerRun?: number;
  budget?: Partial<DiscoveryPreviewBudget>;
  sleep?: (milliseconds: number) => Promise<void>;
  rateLimitState?: { lastRequestAt: number };
  additionalKnownOfficialProfileUrls?: string[];
  writeReport?: (report: DiscoveryPreviewReport) => Promise<string>;
  now?: () => Date;
}

export function parseDiscoveryPreviewBudget(args: readonly string[]): Partial<DiscoveryPreviewBudget> {
  const fields = new Map<string, keyof DiscoveryPreviewBudget>([
    ['--search-budget', 'maxSearchRequestsPerCountry'],
    ['--results-per-search', 'resultsPerSearch'],
    ['--pages-per-query', 'maxPagesPerQuery'],
    ['--page-budget', 'maxPageFetchesPerCountry'],
    ['--request-interval-ms', 'minimumRequestIntervalMs'],
  ]);
  const budget: Partial<DiscoveryPreviewBudget> = {};
  for (const arg of args) {
    const [flag, raw] = arg.split('=', 2);
    const field = fields.get(flag ?? '');
    if (!field) continue;
    const value = Number(raw);
    if (!raw || !Number.isInteger(value)) throw new Error('invalid_preview_budget');
    Object.assign(budget, { [field]: value });
  }
  return budget;
}

function reportText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]')
    .replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function officialSource(value: string, hosts: readonly string[]): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname.toLowerCase())) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

async function writePrivateReport(report: DiscoveryPreviewReport): Promise<string> {
  const directory = resolve(process.cwd(), 'private-data', 'discovery-previews');
  await mkdir(directory, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const country = report.region.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, '-');
  const path = resolve(directory, `${country}-${stamp}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

/** Reads profile and lead state, then runs one no-write preview with the normal evidence gates. */
export async function runDiscoveryPreview(region: DiscoveryRegion, input: DiscoveryPreviewInput = {}) {
  const hosts = [...OFFICIAL_HOSTS_BY_REGION[region]];
  const institution = OFFICIAL_INSTITUTION_BY_REGION[region];
  const generatedAt = (input.now?.() ?? new Date()).toISOString();
  const previewOutcomes: CandidatePreviewOutcome[] = [];
  let storage: PreviewStorage | undefined;
  try {
    storage = await (input.connect ?? (() => connectMongoStorage()))();
    const loadedProfile = await storage.repositories.profiles.get('primary');
    if (!loadedProfile) throw new Error('preview_profile_unavailable');
    if (!loadedProfile.applicant.target.countries.includes(region)) throw new Error('preview_country_not_configured');
    const existingCandidates = await storage.repositories.candidates.list();
    const profile: ApplicantProfile = {
      ...loadedProfile,
      applicant: {
        ...loadedProfile.applicant,
        target: { ...loadedProfile.applicant.target, countries: [region] },
      },
    };
    const researchInterests = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields];
    const repository = {
      async list() { return existingCandidates; },
      async save(_candidate: ProfessorCandidate) { /* Preview saves only to this in-memory adapter. */ },
    };
    const budget: DiscoveryPreviewBudget = {
      ...DEFAULT_DISCOVERY_PREVIEW_BUDGET,
      ...input.budget,
      ...(input.maxPageFetchesPerRun === undefined ? {} : { maxPageFetchesPerCountry: input.maxPageFetchesPerRun }),
    };
    if (!Number.isInteger(budget.maxSearchRequestsPerCountry) || budget.maxSearchRequestsPerCountry < 1 || budget.maxSearchRequestsPerCountry > 40 ||
        !Number.isInteger(budget.resultsPerSearch) || budget.resultsPerSearch < 1 || budget.resultsPerSearch > 20 ||
        !Number.isInteger(budget.maxPagesPerQuery) || budget.maxPagesPerQuery < 1 || budget.maxPagesPerQuery > 10 ||
        !Number.isInteger(budget.maxPageFetchesPerCountry) || budget.maxPageFetchesPerCountry < 1 || budget.maxPageFetchesPerCountry > MAX_OFFICIAL_PAGE_FETCHES_PER_RUN ||
        !Number.isInteger(budget.minimumRequestIntervalMs) || budget.minimumRequestIntervalMs < 0 || budget.minimumRequestIntervalMs > 60_000) {
      throw new Error('preview_page_fetch_cap_invalid');
    }
    let pageFetches = 0;
    let searches = 0;
    let failureCode: string | undefined;
    const coverageStopReasons = new Set<string>();
    const rateLimitState = input.rateLimitState ?? { lastRequestAt: 0 };
    const baseProvider = input.provider ?? new BraveSearchProvider();
    try {
      const result = await discoverProfessorCandidates({
        profile,
        provider: {
          async searchPage(query, options) {
            if (searches >= budget.maxSearchRequestsPerCountry) throw new Error('preview_search_cap_exceeded');
            const remainingWait = Math.max(0, rateLimitState.lastRequestAt + budget.minimumRequestIntervalMs - Date.now());
            if (remainingWait) await (input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(remainingWait);
            rateLimitState.lastRequestAt = Date.now();
            searches += 1;
            const resultLimit = Math.min(options?.count ?? budget.resultsPerSearch, budget.resultsPerSearch);
            const page = baseProvider.searchPage
              ? await baseProvider.searchPage(query, { ...options, count: resultLimit })
              : { results: await baseProvider.search(query, { ...options, count: resultLimit }), moreResultsAvailable: false, paginationKnown: true };
            return { ...page, results: page.results.slice(0, resultLimit) };
          },
          async search(query, options) {
            return (await this.searchPage!(query, options)).results;
          },
        },
        repository,
        options: {
          officialHostsByRegion: { [region]: hosts },
          countryCodesByRegion: { [region]: COUNTRY_CODES_BY_REGION[region] },
          resultsPerQuery: budget.resultsPerSearch,
          oneSearchPerRegion: true,
          oneQueryPerRegion: true,
          maxSearches: budget.maxSearchRequestsPerCountry,
          maxPagesPerQuery: budget.maxPagesPerQuery,
          searchQueryTypes: [...DISCOVERY_PREVIEW_QUERY_TYPES],
          maxPageFetchesPerRun: budget.maxPageFetchesPerCountry,
          ...(input.additionalKnownOfficialProfileUrls ? { additionalKnownOfficialProfileUrls: input.additionalKnownOfficialProfileUrls } : {}),
          saveOnlyProfessorProfiles: true,
          followSupplementaryLinks: false,
          collectContactEmail: false,
          shouldSaveCandidate: (candidate) => prepareSavedProfessorEvidence({
            candidate,
            researchInterests,
            checkedAt: generatedAt,
          }).recommendation === 'likely relevant',
          now: () => new Date(generatedAt),
          fetchPage: async (url) => {
            pageFetches += 1;
            return input.fetchPage
              ? input.fetchPage(url)
              : fetchOfficialPage(url, hosts);
          },
          onCandidatePreview: (outcome) => { previewOutcomes.push(outcome); },
          onCoverageStop: (reason) => { coverageStopReasons.add(reason); },
        },
      });
      searches = result.searches;
    } catch (error) {
      failureCode = safeFailureRecord(error).kind;
      coverageStopReasons.add(searches > 0 ? 'search_provider_error' : 'preview_pipeline_error');
    }

    const candidates = previewOutcomes.map((outcome, index) => {
      const profileSource = outcome.officialProfileSource ? officialSource(outcome.officialProfileSource, hosts) : undefined;
      const researchSources = outcome.supportingResearch.slice(0, 5).flatMap((source) => {
        const url = officialSource(source.sourceUrl, hosts);
        const supportingEvidence = reportText(source.quote, 360);
        return url && supportingEvidence ? [{ url, supportingEvidence }] : [];
      });
      return {
        recordId: `candidate-${String(index + 1).padStart(2, '0')}`,
        name: reportText(outcome.name, 160) || 'Unidentified result',
        identityVerified: outcome.identityVerified,
        institution,
        outcome: outcome.outcome,
        reason: outcome.reasonCode,
        interestMatch: outcome.reasonCode === 'passed_all_gates'
          ? 'matched' as const
          : outcome.reasonCode === 'research_interest_mismatch'
            ? 'not_matched' as const
            : 'not_evaluated' as const,
        matchExplanation: outcome.reasonCode === 'passed_all_gates'
          ? 'Official research evidence matched the saved profile interests.'
          : outcome.reasonCode === 'research_interest_mismatch'
            ? 'Official research evidence was found but did not match the saved profile interests.'
            : 'The research-interest check was not reached because an earlier verification gate stopped this result.',
        reviewStatus: 'awaiting_owner_review' as const,
        approved: false as const,
        queued: false as const,
        sent: false as const,
        ...(profileSource ? { officialProfileSource: profileSource } : {}),
        researchSources,
      };
    });
    const reasonCounts: Partial<Record<CandidatePreviewReason, number>> = {};
    for (const candidate of candidates) reasonCounts[candidate.reason] = (reasonCounts[candidate.reason] ?? 0) + 1;
    const passed = candidates.filter(({ outcome }) => outcome === 'passed').length;
    const duplicates = candidates.filter(({ reason }) => reason === 'duplicate_saved_lead' || reason === 'duplicate_official_profile').length;
    const searchCoverage = failureCode ? 'failed' as const : coverageStopReasons.size ? 'incomplete' as const : 'complete' as const;
    const report: DiscoveryPreviewReport = {
      generatedAt,
      region,
      institution,
      status: failureCode ? 'failed' : 'completed',
      searches,
      searchStrategies: [...DISCOVERY_PREVIEW_QUERY_TYPES],
      searchCoverage,
      coverageStopReasons: [...coverageStopReasons],
      budget,
      results: candidates.length,
      pageFetches,
      passed,
      stopped: candidates.length - passed,
      duplicates,
      reasonCounts,
      ...(failureCode ? { failureCode } : {}),
      candidates,
    };
    const reportPath = await (input.writeReport ?? writePrivateReport)(report);
    return {
      ok: !failureCode,
      reportPath,
      summary: {
        region, searches, results: candidates.length, pageFetches, passed, duplicates, searchCoverage, coverageStopReasons: [...coverageStopReasons],
        stopped: candidates.length - passed, reasonCounts,
        ...(failureCode ? { failureCode } : {}),
      },
      report,
    };
  } finally {
    try { await storage?.close(); } catch { /* Closing MongoDB does not change the local preview report. */ }
  }
}

/** Backward-compatible entry point for the original Canada preview command. */
export function runCanadaDiscoveryPreview(input: DiscoveryPreviewInput = {}) {
  return runDiscoveryPreview('Canada', input);
}

async function run(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const region = requestedDiscoveryRegion(args) ?? (args.length === 0 ? 'Canada' : undefined);
    if (!region) throw new Error('invalid_preview_country');
    const result = await runDiscoveryPreview(region, { budget: parseDiscoveryPreviewBudget(args) });
    const { report: _privateReportDetails, ...safeResult } = result;
    process.stdout.write(`${JSON.stringify(safeResult)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: safeFailureRecord(error).kind })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
