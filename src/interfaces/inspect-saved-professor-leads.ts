import '../infrastructure/local-env.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { inspectSavedUnreviewedLeads } from '../application/automatic-discovery.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { fetchOfficialPage } from '../application/research-discovery.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

export async function runSavedLeadInspection(): Promise<void> {
  let storage: Awaited<ReturnType<typeof connectMongoStorage>> | undefined;
  try {
    storage = await connectMongoStorage();
    const report = await inspectSavedUnreviewedLeads({
      repositories: {
        candidates: storage.repositories.candidates,
        profile: storage.repositories.profiles,
        schedule: storage.repositories.discoverySchedule,
        runs: storage.repositories.discoveryRuns,
        checks: storage.repositories.discoveryChecks,
      },
      verifiedCountries: Object.keys(OFFICIAL_HOSTS_BY_REGION),
      officialHostsByRegion: Object.fromEntries(Object.entries(OFFICIAL_HOSTS_BY_REGION).map(([country, hosts]) => [country, [...hosts]])),
      fetchPage: (url, hosts) => fetchOfficialPage(url, hosts),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const failure = safeFailureRecord(error);
    process.stderr.write(`${JSON.stringify({ ok: false, kind: failure.kind, errorName: failure.errorName, code: failure.errorCode })}\n`);
    process.exitCode = 1;
  } finally {
    try { await storage?.close(); } catch { /* Inspection outcome does not depend on shutdown diagnostics. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runSavedLeadInspection();
