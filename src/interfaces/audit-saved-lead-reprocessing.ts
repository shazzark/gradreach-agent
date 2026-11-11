import '../infrastructure/local-env.ts';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

const SAFE_REASONS = new Set([
  'evidence_added', 'protected_state', 'missing_source', 'official_host_rejected', 'duplicate_profile',
  'duplicate_identifier', 'run_fetch_limit', 'identity_not_established', 'identity_mismatch',
  'research_evidence_missing', 'interest_mismatch', 'no_new_evidence', 'record_changed',
  'invalid_content', 'http_status', 'rate_limited', 'network_error', 'disallowed_host',
  'rejected_redirect', 'timeout', 'dns_tls', 'fetch_failed',
]);
const SAFE_OUTCOMES = new Set(['enriched', 'unchanged', 'failed']);
const SAFE_STAGES = new Set(['eligibility_gate', 'official_page_fetch', 'identity_check', 'research_check', 'interest_check', 'duplicate_check', 'persistence_check', 'fetch_limit', 'enriched']);

function safeTraversal(input: unknown) {
  const data = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const bounded = (value: unknown, max: number) => typeof value === 'number' && Number.isInteger(value) ? Math.max(0, Math.min(max, value)) : 0;
  return {
    directoryFetched: data.directoryFetched === true,
    profileLinksConsidered: bounded(data.profileLinksConsidered, 100),
    profileLinksSelected: bounded(data.profileLinksSelected, 10),
    profileLinksFetched: bounded(data.profileLinksFetched, 10),
    identityEstablished: data.identityEstablished === true,
    researchLinksConsidered: bounded(data.researchLinksConsidered, 100),
    researchLinksEligible: bounded(data.researchLinksEligible, 100),
    researchLinksSelected: bounded(data.researchLinksSelected, 5),
    researchLinksFetched: bounded(data.researchLinksFetched, 5),
    relevantResearchEstablished: data.relevantResearchEstablished === true,
  };
}

/** Prints only the latest run's aggregate state; stable lead IDs remain inside MongoDB. */
export async function auditSavedLeadReprocessing(): Promise<void> {
  let storage: Awaited<ReturnType<typeof connectMongoStorage>> | undefined;
  let summary: Record<string, unknown>;
  let failed = false;
  try {
    storage = await connectMongoStorage();
    const run = (await storage.repositories.savedLeadReprocessRuns.list(1))[0];
    if (!run) {
      summary = { ok: true, found: false };
    } else {
      const results = [...run.results];
      const recordedIds = new Set(results.map((result) => result.candidateId));
      const markedIds = await storage.repositories.candidates.listReprocessedLeadIds(run.id);
      const markedSet = new Set(markedIds);
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (markedSet.has(result.candidateId)) {
          results[index] = {
            ...result, outcome: 'enriched', reasonCode: 'evidence_added',
            diagnostics: { ...result.diagnostics, stageOutcome: 'enriched' },
          };
        }
      }
      for (const candidateId of markedIds) {
        if (!recordedIds.has(candidateId)) results.push({
          candidateId, outcome: 'enriched', reasonCode: 'evidence_added',
          diagnostics: {
            stageOutcome: 'enriched',
            traversal: safeTraversal(undefined),
          },
        });
      }
      const safeResults = results.map((result) => ({
        candidateId: result.candidateId,
        outcome: SAFE_OUTCOMES.has(result.outcome) ? result.outcome : 'failed',
        reasonCode: SAFE_REASONS.has(result.reasonCode) ? result.reasonCode : 'fetch_failed',
        diagnostics: result.diagnostics,
      }));
      const counts = { inspected: safeResults.length, enriched: 0, unchanged: 0, failed: 0 };
      const reasonCounts: Record<string, number> = {};
      for (const result of safeResults) {
        counts[result.outcome] += 1;
        reasonCounts[result.reasonCode] = (reasonCounts[result.reasonCode] ?? 0) + 1;
      }
      const leads = safeResults.map((result) => ({
        recordId: `lead-${createHash('sha256').update(`${run.id}:${result.candidateId}`).digest('hex').slice(0, 8)}`,
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        stageOutcome: SAFE_STAGES.has(result.diagnostics?.stageOutcome) ? result.diagnostics.stageOutcome : 'eligibility_gate',
        traversal: safeTraversal(result.diagnostics?.traversal),
        ...(typeof result.diagnostics?.failedStage === 'string' && ['official_page_fetch', 'profile_page_fetch', 'research_page_fetch'].includes(result.diagnostics.failedStage)
          ? { failedStage: result.diagnostics.failedStage } : {}),
        ...(typeof result.diagnostics?.httpStatus === 'number' && Number.isInteger(result.diagnostics.httpStatus) && result.diagnostics.httpStatus >= 100 && result.diagnostics.httpStatus <= 599
          ? { httpStatus: result.diagnostics.httpStatus } : {}),
        ...(typeof result.diagnostics?.contentErrorCode === 'string' && ['unsupported_content_type', 'empty_content', 'unsupported_document', 'invalid_content'].includes(result.diagnostics.contentErrorCode)
          ? { contentErrorCode: result.diagnostics.contentErrorCode } : {}),
      }));
      summary = {
        ok: true, found: true, runId: run.id, state: run.state,
        counts, reasonCounts, leads,
        omittedByLeadLimit: run.omittedByLeadLimit,
        duplicateIdentifiersSkipped: run.duplicateIdentifiersSkipped,
        ...(run.failureReason ? { failureReason: run.failureReason } : {}),
      };
    }
  } catch (error) {
    failed = true;
    summary = { ok: false, reason: safeFailureRecord(error).kind };
  } finally {
    try { await storage?.close(); } catch { /* Read-only audit output is independent of shutdown. */ }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await auditSavedLeadReprocessing();
}
