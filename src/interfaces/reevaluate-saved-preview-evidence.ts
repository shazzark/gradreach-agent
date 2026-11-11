import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reevaluateSavedPreviewEvidence, type SavedPreviewEvidenceRecord } from '../application/replay-preview-evidence.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

const SOURCE_REPORT = 'private-data/discovery-previews/canada-replay-2026-11-09T08-03-15-343Z-52fd304f.json';

interface SavedReport {
  generatedAt: string;
  candidates: SavedPreviewEvidenceRecord[];
}

async function readPreferences() {
  const storage = await connectMongoStorage();
  try {
    const profile = await storage.repositories.profiles.get('primary');
    if (!profile) throw new Error('profile_unavailable');
    return [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields];
  } finally { await storage.close(); }
}

async function writePrivateReport(value: unknown, generatedAt: string): Promise<string> {
  const directory = resolve(process.cwd(), 'private-data', 'discovery-previews');
  await mkdir(directory, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const path = resolve(directory, `canada-offline-reevaluation-${stamp}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

async function run(): Promise<void> {
  try {
    const [sourceText, interests] = await Promise.all([readFile(SOURCE_REPORT, 'utf8'), readPreferences()]);
    const source = JSON.parse(sourceText) as SavedReport;
    const evaluatedAt = new Date().toISOString();
    const candidates = source.candidates.map((candidate) => reevaluateSavedPreviewEvidence(candidate, interests));
    const reasonCounts: Record<string, number> = {};
    for (const candidate of candidates) reasonCounts[candidate.reasonCode] = (reasonCounts[candidate.reasonCode] ?? 0) + 1;
    const report = {
      evaluatedAt,
      mode: 'offline_saved_evidence_only',
      sourceReport: basename(SOURCE_REPORT),
      candidateCount: candidates.length,
      webRequests: 0,
      mongoWrites: 0,
      preferenceValuesIncluded: false,
      reasonCounts,
      candidates,
    };
    const reportPath = await writePrivateReport(report, evaluatedAt);
    process.stdout.write(`${JSON.stringify({ ok: true, reportPath, candidateCount: candidates.length, reasonCounts })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, errorCode: safeFailureRecord(error).kind })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
