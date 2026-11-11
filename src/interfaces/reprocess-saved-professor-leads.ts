import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { reprocessSavedProfessorLeads } from '../application/reprocess-saved-professor-leads.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import type { SavedLeadReprocessReport, SavedLeadReprocessResult, SavedLeadReprocessRun } from '../domain/saved-lead-reprocessing.ts';
import { fetchOfficialPage } from '../application/research-discovery.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

function emptyReport(): SavedLeadReprocessReport {
  return { counts: { inspected: 0, enriched: 0, unchanged: 0, failed: 0, pageFetches: 0 }, reasonCounts: {}, omittedByLeadLimit: 0, duplicateIdentifiersSkipped: 0 };
}

function summarizeResults(results: SavedLeadReprocessResult[]): Pick<SavedLeadReprocessRun, 'counts' | 'reasonCounts'> {
  const counts = { inspected: results.length, enriched: 0, unchanged: 0, failed: 0, pageFetches: 0 };
  const reasonCounts: SavedLeadReprocessRun['reasonCounts'] = {};
  for (const result of results) {
    counts[result.outcome] += 1;
    reasonCounts[result.reasonCode] = (reasonCounts[result.reasonCode] ?? 0) + 1;
  }
  return { counts, reasonCounts };
}

/** Runs one bounded refresh and writes only allowlisted summary and per-lead reason codes. */
export async function runSavedProfessorLeadReprocessing(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const results: SavedLeadReprocessResult[] = [];
  let report = emptyReport();
  let failureReason: string | undefined;
  let storage: Awaited<ReturnType<typeof connectMongoStorage>> | undefined;
  let runStarted = false;
  let state: SavedLeadReprocessRun['state'] = 'failed';

  try {
    storage = await connectMongoStorage();
    const run: SavedLeadReprocessRun = {
      id: runId, state: 'running', startedAt, counts: emptyReport().counts, reasonCounts: {},
      omittedByLeadLimit: 0, duplicateIdentifiersSkipped: 0, results: [],
    };
    await storage.repositories.savedLeadReprocessRuns.start(run);
    runStarted = true;

    report = await reprocessSavedProfessorLeads({
      repositories: { candidates: storage.repositories.candidates, profiles: storage.repositories.profiles },
      officialHostsByRegion: Object.fromEntries(Object.entries(OFFICIAL_HOSTS_BY_REGION).map(([region, hosts]) => [region, [...hosts]])),
      fetchPage: (url, hosts) => fetchOfficialPage(url, hosts),
      runId,
      onLeadResult: async (result) => {
        results.push(result);
        const stored = await storage!.repositories.savedLeadReprocessRuns.recordResult(runId, result);
        if (!stored) throw new Error('run_result_persistence_failed');
      },
    });
    state = 'completed';
  } catch (error) {
    failureReason = safeFailureRecord(error).kind;
    state = 'failed';
    const derived = summarizeResults(results);
    report = { ...emptyReport(), counts: derived.counts, reasonCounts: derived.reasonCounts };
  }

  const finishedAt = new Date().toISOString();
  if (state === 'completed') {
    const saved = summarizeResults(results);
    // Keep the persisted aggregate consistent with the individually recoverable outcomes.
    report = { ...report, counts: { ...report.counts, inspected: saved.counts.inspected, enriched: saved.counts.enriched, unchanged: saved.counts.unchanged, failed: saved.counts.failed }, reasonCounts: saved.reasonCounts };
  }
  if (runStarted && storage) {
    const finalRun: SavedLeadReprocessRun = {
      id: runId, state, startedAt, finishedAt, counts: report.counts,
      reasonCounts: report.reasonCounts, omittedByLeadLimit: report.omittedByLeadLimit,
      duplicateIdentifiersSkipped: report.duplicateIdentifiersSkipped, results,
      ...(failureReason ? { failureReason } : {}),
    };
    try { await storage.repositories.savedLeadReprocessRuns.finish(finalRun); }
    catch (error) { failureReason = safeFailureRecord(error).kind; state = 'failed'; }
  }
  try { await storage?.close(); } catch { /* Closing MongoDB does not change the saved run outcome. */ }

  const summary = {
    ok: state === 'completed', runId, state, counts: report.counts,
    reasonCounts: report.reasonCounts, omittedByLeadLimit: report.omittedByLeadLimit,
    duplicateIdentifiersSkipped: report.duplicateIdentifiersSkipped,
    ...(failureReason ? { failureReason } : {}),
    ...(runStarted ? {} : { persistence: 'unavailable' as const }),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (state !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runSavedProfessorLeadReprocessing();
}
