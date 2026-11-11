import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConfirmedProfessorReports, type ConfirmedProfessorDiagnosticInput, type ConfirmedProfessorReportInput, type LocalOwnerDecisionInput } from '../application/confirmed-professors.ts';
import { deduplicateResearchTargets, enrichConfirmedProfessorResearch, isResearchEnrichmentComplete, mergeResearchEnrichmentReport, type ConfirmedProfessorResearchReport, type ConfirmedProfessorResearchResult } from '../application/confirmed-professor-research-enrichment.ts';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';

const REPORT_DIRECTORY = resolve(process.cwd(), 'private-data', 'discovery-previews');
export const RESEARCH_ENRICHMENT_REPORT_PATH = resolve(REPORT_DIRECTORY, 'confirmed-professors-research-enrichment.json');
const BATCH_SIZE = 5;
const MAX_BATCH_PAGE_FETCHES = 30;

interface ConfirmedInputs {
  reports: ConfirmedProfessorReportInput[];
  diagnostics: ConfirmedProfessorDiagnosticInput[];
  ownerDecision?: LocalOwnerDecisionInput;
}

async function readConfirmedInputs(): Promise<ConfirmedInputs> {
  const names = await readdir(REPORT_DIRECTORY);
  const reports: ConfirmedProfessorReportInput[] = [];
  const diagnostics: ConfirmedProfessorDiagnosticInput[] = [];
  const ownerFiles = names.filter((name) => /^candidate-03-owner-review-.*\.json$/i.test(name));
  const ownerDecisions = await Promise.all(ownerFiles.map(async (name) => {
    try {
      const report = JSON.parse(await readFile(resolve(REPORT_DIRECTORY, name), 'utf8')) as LocalOwnerDecisionInput & { generatedAt?: unknown };
      return { name, report, timestamp: typeof report.generatedAt === 'string' ? Date.parse(report.generatedAt) : 0 };
    } catch { return undefined; }
  }));
  const ownerDecision = ownerDecisions.filter((item): item is NonNullable<typeof item> => Boolean(item) && item!.report.ownerDecision === 'accepted' && item!.report.decisionScope === 'local_preview_only' && item!.report.mongoSaved === false)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  for (const name of names.filter((item) => item.toLowerCase().endsWith('.json'))) {
    if (/^continuation-manifest-/i.test(name) || /^confirmed-professors-research-enrichment(?:\.|-)/i.test(name)) continue;
    try {
      const report = JSON.parse(await readFile(resolve(REPORT_DIRECTORY, name), 'utf8')) as Record<string, unknown>;
      if (/^canada-replay-/i.test(name) && Array.isArray(report.candidates)) {
        diagnostics.push({ reportName: name, kind: 'replay', candidates: report.candidates });
      } else if (/^canada-offline-reevaluation-/i.test(name) && Array.isArray(report.candidates)) {
        diagnostics.push({ reportName: name, kind: 'reevaluation', ...(typeof report.sourceReport === 'string' ? { sourceReport: basename(report.sourceReport) } : {}), candidates: report.candidates });
      } else if (!/^candidate-03-owner-review-/i.test(name) && Array.isArray(report.candidates)) {
        reports.push({ reportName: name, ...(typeof report.region === 'string' ? { country: report.region } : {}), candidates: report.candidates });
      }
    } catch { /* Unreadable historical reports cannot contribute an eligible identity. */ }
  }
  return { reports, diagnostics, ...(ownerDecision ? { ownerDecision: { ...ownerDecision.report, sourceReport: ownerDecision.name } } : {}) };
}

async function readProfile(): Promise<ApplicantProfile> {
  const storage = await connectMongoStorage();
  try {
    const profile = await storage.repositories.profiles.get('primary');
    if (!profile) throw new Error('primary_profile_missing');
    return profile;
  } finally { await storage.close(); }
}

async function readSavedReport(): Promise<ConfirmedProfessorResearchReport | undefined> {
  let text: string;
  try {
    text = await readFile(RESEARCH_ENRICHMENT_REPORT_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('enrichment_report_unavailable');
  }
  try {
    const value = JSON.parse(text) as ConfirmedProfessorResearchReport;
    if (value.schemaVersion !== 1 || !Array.isArray(value.professors)) throw new Error('invalid_schema');
    return value;
  } catch { throw new Error('enrichment_report_invalid'); }
}

async function persistReport(report: ConfirmedProfessorResearchReport): Promise<void> {
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  const temporaryPath = `${RESEARCH_ENRICHMENT_REPORT_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporaryPath, RESEARCH_ENRICHMENT_REPORT_PATH);
}

function reportTargets(inputs: ConfirmedInputs) {
  const result = parseConfirmedProfessorReports(inputs.reports, inputs.ownerDecision, inputs.diagnostics);
  return deduplicateResearchTargets(result.professors.map(({ stableId, name, institution, country, officialProfileUrl }) => ({ stableId, name, institution, country, officialProfileUrl })));
}

export async function enrichSavedConfirmedProfessors(input: {
  targets: ReturnType<typeof reportTargets>;
  interests: string[];
  previous?: ConfirmedProfessorResearchReport;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  onReport?: (report: ConfirmedProfessorResearchReport) => Promise<void> | void;
}): Promise<ConfirmedProfessorResearchReport> {
  const generatedAt = (input.now?.() ?? new Date()).toISOString();
  let report = mergeResearchEnrichmentReport(input.previous, generatedAt, input.targets, []);
  const savedById = new Map(report.professors.map((row) => [row.stableId, row]));
  const todo = input.targets.filter((target) => !isResearchEnrichmentComplete(savedById.get(target.stableId)));

  for (let offset = 0; offset < todo.length; offset += BATCH_SIZE) {
    const pageFetchBudget = { remaining: MAX_BATCH_PAGE_FETCHES };
    for (const target of todo.slice(offset, offset + BATCH_SIZE)) {
      const result = await enrichConfirmedProfessorResearch({
        target, interests: input.interests, checkedAt: (input.now?.() ?? new Date()).toISOString(),
        pageFetchBudget, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      savedById.set(result.stableId, result);
      report = mergeResearchEnrichmentReport(undefined, (input.now?.() ?? new Date()).toISOString(), input.targets, [...savedById.values()]);
      await input.onReport?.(report);
    }
  }
  return report;
}

export async function runConfirmedProfessorResearchEnrichment(dependencies: {
  readProfile: () => Promise<ApplicantProfile>;
  readInputs: () => Promise<ConfirmedInputs>;
  readReport: () => Promise<ConfirmedProfessorResearchReport | undefined>;
  saveReport: (report: ConfirmedProfessorResearchReport) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<{ report: ConfirmedProfessorResearchReport; counts: Record<ConfirmedProfessorResearchResult['outcome'], number> }> {
  const [profile, inputs, previous] = await Promise.all([dependencies.readProfile(), dependencies.readInputs(), dependencies.readReport()]);
  const targets = reportTargets(inputs);
  if (targets.length !== 45) throw new Error('confirmed_professor_count_mismatch');
  const interests = profile.applicant.target.researchInterests;
  if (!interests.length) throw new Error('saved_research_interests_missing');
  const report = await enrichSavedConfirmedProfessors({ targets, interests, ...(previous ? { previous } : {}), ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}), onReport: dependencies.saveReport });
  await dependencies.saveReport(report);
  const counts: Record<ConfirmedProfessorResearchResult['outcome'], number> = {
    matched: 0, evidence_found_no_match: 0, no_research_evidence: 0, fetch_failed: 0, not_evaluated: 0,
  };
  for (const row of report.professors) counts[row.outcome] += 1;
  counts.not_evaluated += Math.max(0, targets.length - report.professors.length);
  return { report, counts };
}

async function main(): Promise<void> {
  try {
    const result = await runConfirmedProfessorResearchEnrichment({
      readProfile, readInputs: readConfirmedInputs, readReport: readSavedReport, saveReport: persistReport,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, reportPath: 'private-data/discovery-previews/confirmed-professors-research-enrichment.json', total: result.report.totalProfessors, completed: result.report.completedProfessors, counts: result.counts })}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]{3,60}$/.test(error.message) ? error.message : 'enrichment_failed';
    process.stdout.write(`${JSON.stringify({ ok: false, errorCode: code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
