import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { OFFICIAL_INSTITUTION_BY_REGION } from '../config/official-host-allowlist.ts';
import { planDiscoveryPreviewContinuation } from '../application/discovery-preview-continuation.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';
import { DEFAULT_DISCOVERY_PREVIEW_BUDGET, parseDiscoveryPreviewBudget, runDiscoveryPreview, type DiscoveryPreviewReport } from './discover-professor-preview.ts';

async function readPreviouslyPreviewedCountries(): Promise<string[]> {
  const directory = resolve(process.cwd(), 'private-data', 'discovery-previews');
  const files = await readdir(directory).catch(() => []);
  const countries = new Set<string>();
  for (const filename of files.filter((name) => name.endsWith('.json'))) {
    try {
      const text = (await readFile(resolve(directory, filename), 'utf8')).replace(/^\uFEFF/, '');
      const report = JSON.parse(text) as { region?: unknown };
      if (typeof report.region === 'string') countries.add(report.region);
    } catch { /* An unreadable private report cannot identify a country to skip. */ }
  }
  return [...countries];
}

async function writePrivateJson(prefix: string, value: unknown): Promise<string> {
  const directory = resolve(process.cwd(), 'private-data', 'discovery-previews');
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(directory, `${prefix}-${stamp}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

function candidateRow(country: string, candidate: DiscoveryPreviewReport['candidates'][number]) {
  return {
    country,
    recordId: candidate.recordId,
    name: candidate.name,
    institution: candidate.institution,
    identityVerified: candidate.identityVerified,
    officialProfileSource: candidate.officialProfileSource,
    researchSources: candidate.researchSources,
    interestMatch: candidate.interestMatch,
    matchExplanation: candidate.matchExplanation,
    duplicate: candidate.reason === 'duplicate_saved_lead' || candidate.reason === 'duplicate_official_profile',
    outcome: candidate.outcome,
    reason: candidate.reason,
    reviewStatus: candidate.reviewStatus,
  };
}

async function run(): Promise<void> {
  let storage: Awaited<ReturnType<typeof connectMongoStorage>> | undefined;
  try {
    storage = await connectMongoStorage();
    const profile = await storage.repositories.profiles.get('primary');
    if (!profile) throw new Error('preview_profile_unavailable');
    const args = process.argv.slice(2);
    const allCountriesMode = args.includes('--all-countries');
    const budget = parseDiscoveryPreviewBudget(args);
    const runs = allCountriesMode ? [] : await storage.repositories.discoveryRuns.list(100);
    const previousPreviews = allCountriesMode ? [] : await readPreviouslyPreviewedCountries();
    const plan = planDiscoveryPreviewContinuation({
      countries: profile.applicant.target.countries,
      ...(allCountriesMode ? {} : { afterCountry: 'Belgium' }),
      verifiedHosts: OFFICIAL_HOSTS_BY_REGION,
      attemptedCountries: [...runs.map((record) => record.country).filter((value): value is string => Boolean(value)), ...previousPreviews],
      batchSize: 5,
    });
    if (!plan.anchorFound) throw new Error('preview_resume_anchor_missing');

    const batchSummaries: Array<{ batchNumber: number; countriesAttempted: string[]; candidates: ReturnType<typeof candidateRow>[]; results: Array<Record<string, unknown>>; reportPath: string }> = [];
    const seenOfficialProfileUrls = new Set<string>();
    const rateLimitState = { lastRequestAt: 0 };
    for (const [batchIndex, countries] of plan.batches.entries()) {
      const reports: DiscoveryPreviewReport[] = [];
      const results: Array<Record<string, unknown>> = [];
      for (const region of countries) {
        try {
          const result = await runDiscoveryPreview(region, { budget, rateLimitState, additionalKnownOfficialProfileUrls: [...seenOfficialProfileUrls] });
          reports.push(result.report);
          for (const candidate of result.report.candidates) {
            if (candidate.officialProfileSource) seenOfficialProfileUrls.add(candidate.officialProfileSource);
          }
          results.push({
            country: region,
            institution: OFFICIAL_INSTITUTION_BY_REGION[region],
            reportPath: result.reportPath,
            searches: result.summary.searches,
            searchCoverage: result.summary.searchCoverage,
            coverageStopReasons: result.summary.coverageStopReasons,
            candidatesFound: result.summary.results,
            pageFetches: result.summary.pageFetches,
            budget: result.report.budget,
            passedChecks: result.summary.passed,
            stopped: result.summary.stopped,
            duplicates: result.summary.duplicates,
            stopReasonCounts: result.summary.reasonCounts,
            ...(result.summary.failureCode ? { failureCode: result.summary.failureCode } : {}),
          });
        } catch (error) {
          results.push({ country: region, status: 'failed_before_report', errorCode: safeFailureRecord(error).kind, searches: 0, candidatesFound: 0 });
        }
      }
      const candidates = reports.flatMap((report) => report.candidates.map((candidate) => candidateRow(report.region, candidate)));
      const batch = {
        generatedAt: new Date().toISOString(),
        mode: 'no_write_country_preview_batch',
        countryScope: allCountriesMode ? 'all_saved_countries_with_verified_hosts' : 'saved_order_after_Belgium',
        batchNumber: batchIndex + 1,
        countriesAttempted: countries,
        countriesSkipped: batchIndex === 0 ? plan.skipped : [],
        mongoWrites: 0,
        candidates,
        results,
      };
      const reportPath = await writePrivateJson('continuation-batch', batch);
      const summary = { batchNumber: batchIndex + 1, countriesAttempted: countries, candidates, results, reportPath };
      batchSummaries.push(summary);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    }

    if (plan.batches.length === 0) {
      const reportPath = await writePrivateJson('continuation-batch', {
        generatedAt: new Date().toISOString(), mode: 'no_write_country_preview_batch', countriesAttempted: [],
        countriesSkipped: plan.skipped, mongoWrites: 0, candidates: [], results: [],
      });
      process.stdout.write(`${JSON.stringify({ batchNumber: 0, countriesAttempted: [], candidates: [], results: [], reportPath })}\n`);
    }
    const manifestPath = await writePrivateJson('continuation-manifest', {
      generatedAt: new Date().toISOString(), mode: 'no_write_country_preview_continuation', afterCountry: allCountriesMode ? null : 'Belgium',
      countryScope: allCountriesMode ? 'all_saved_countries_with_verified_hosts' : 'saved_order_after_Belgium',
      budget: { ...DEFAULT_DISCOVERY_PREVIEW_BUDGET, ...budget },
      attemptedCountries: plan.attemptedCountries, skippedCountries: plan.skipped, batchCount: plan.batches.length,
      mongoWrites: 0, batchReports: batchSummaries.map(({ reportPath }) => reportPath),
    });
    process.stdout.write(`${JSON.stringify({ complete: true, countryScope: allCountriesMode ? 'all_saved_countries_with_verified_hosts' : 'saved_order_after_Belgium', attemptedCountryCount: plan.attemptedCountries.length, skippedCountries: plan.skipped, batchCount: plan.batches.length, manifestPath })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ complete: false, errorCode: safeFailureRecord(error).kind })}\n`);
    process.exitCode = 1;
  } finally { await storage?.close(); }
}

await run();
