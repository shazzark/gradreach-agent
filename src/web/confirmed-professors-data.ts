import 'server-only';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseConfirmedProfessorReports, type ConfirmedProfessorDiagnosticInput, type ConfirmedProfessorParseResult, type ConfirmedProfessorReportInput, type LocalOwnerDecisionInput } from '../application/confirmed-professors.ts';
import { validatedResearchEnrichmentRow, type ConfirmedProfessorResearchResult } from '../application/confirmed-professor-research-enrichment.ts';

const RESEARCH_ENRICHMENT_FILE = 'confirmed-professors-research-enrichment.json';

interface ContinuationManifest {
  generatedAt?: unknown;
  countryScope?: unknown;
  batchCount?: unknown;
  batchReports?: unknown;
  skippedCountries?: unknown;
}

export type ConfirmedProfessorPageData =
  | { status: 'available'; source: string; countriesCovered: number; skippedCountries: string[]; result: ConfirmedProfessorParseResult; researchEnrichment: Map<string, ConfirmedProfessorResearchResult> }
  | { status: 'unavailable' }
  | { status: 'error' };

function safeFilePath(directory: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const path = resolve(value);
  const pathFromDirectory = relative(directory, path);
  if (!pathFromDirectory || pathFromDirectory === '.' || pathFromDirectory === '..' || pathFromDirectory.startsWith(`..${sep}`) || isAbsolute(pathFromDirectory)) return undefined;
  return path;
}

async function readLocalOwnerDecision(directory: string): Promise<LocalOwnerDecisionInput | undefined> {
  const files = (await readdir(directory)).filter((name) => /^candidate-03-owner-review-.*\.json$/i.test(name));
  const entries = await Promise.all(files.map(async (name) => {
    const path = resolve(directory, name);
    try {
      const [text, file] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const report = JSON.parse(text) as LocalOwnerDecisionInput & { generatedAt?: unknown };
      return { name, report, modified: file.mtimeMs, generatedAt: typeof report.generatedAt === 'string' ? Date.parse(report.generatedAt) : 0 };
    } catch { return undefined; }
  }));
  const selected = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry!.report.ownerDecision === 'accepted' && entry!.report.decisionScope === 'local_preview_only' && entry!.report.mongoSaved === false)
    .sort((a, b) => (b.generatedAt || b.modified) - (a.generatedAt || a.modified))[0];
  if (!selected) return undefined;
  return { ...selected.report, sourceReport: selected.name };
}

/** Reads only ignored local preview reports; this loader never opens a MongoDB connection. */
export async function loadConfirmedProfessorPreviewData(
  directory = resolve(process.cwd(), 'private-data', 'discovery-previews'),
): Promise<ConfirmedProfessorPageData> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unavailable' };
    return { status: 'error' };
  }

  const manifestFiles = names.filter((name) => /^continuation-manifest-.*\.json$/i.test(name));
  const manifests = await Promise.all(manifestFiles.map(async (name) => {
    try {
      const manifest = JSON.parse(await readFile(resolve(directory, name), 'utf8')) as ContinuationManifest;
      if (manifest.countryScope !== 'all_saved_countries_with_verified_hosts' || !Array.isArray(manifest.batchReports)) return undefined;
      const file = await stat(resolve(directory, name));
      const generatedAt = typeof manifest.generatedAt === 'string' ? Date.parse(manifest.generatedAt) : 0;
      return { name, manifest, modified: file.mtimeMs, generatedAt };
    } catch { return undefined; }
  }));
  const latest = manifests.filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => (b.generatedAt || b.modified) - (a.generatedAt || a.modified))[0];
  try {
    const reportInputs: ConfirmedProfessorReportInput[] = [];
    const diagnosticInputs: ConfirmedProfessorDiagnosticInput[] = [];
    const coveredCountries = new Set<string>();
    const localDecision = await readLocalOwnerDecision(directory).catch(() => undefined);
    for (const name of names.filter((item) => item.toLowerCase().endsWith('.json'))) {
      if (/^continuation-manifest-/i.test(name)) continue;
      try {
        const report = JSON.parse(await readFile(resolve(directory, name), 'utf8')) as Record<string, unknown>;
        if (/^canada-replay-/i.test(name) && Array.isArray(report.candidates)) {
          diagnosticInputs.push({ reportName: name, kind: 'replay', candidates: report.candidates });
          continue;
        }
        if (/^canada-offline-reevaluation-/i.test(name) && Array.isArray(report.candidates)) {
          diagnosticInputs.push({ reportName: name, kind: 'reevaluation', ...(typeof report.sourceReport === 'string' ? { sourceReport: basename(report.sourceReport) } : {}), candidates: report.candidates });
          continue;
        }
        if (/^candidate-03-owner-review-/i.test(name)) continue;
        if (Array.isArray(report.candidates)) {
          const country = typeof report.region === 'string' ? report.region : undefined;
          if (country) coveredCountries.add(country);
          reportInputs.push({ reportName: name, ...(country ? { country } : {}), candidates: report.candidates });
          if (Array.isArray(report.countriesAttempted)) {
            for (const item of report.countriesAttempted) if (typeof item === 'string') coveredCountries.add(item);
          }
        }
      } catch { /* An unreadable historical report is skipped; valid local reports remain usable. */ }
    }
    if (!reportInputs.length) return { status: 'unavailable' };
    if (latest && Array.isArray(latest.manifest.batchReports)) {
      for (const value of latest.manifest.batchReports as unknown[]) {
        const path = safeFilePath(directory, value);
        if (!path) continue;
        try {
          const batch = JSON.parse(await readFile(path, 'utf8')) as { countriesAttempted?: unknown };
          if (Array.isArray(batch.countriesAttempted)) for (const item of batch.countriesAttempted) if (typeof item === 'string') coveredCountries.add(item);
        } catch { /* The individual report reader above already handles available report files. */ }
      }
    }
    const skipped = latest && Array.isArray(latest.manifest.skippedCountries)
      ? latest.manifest.skippedCountries.flatMap((item) => item && typeof item === 'object' && typeof (item as { country?: unknown }).country === 'string'
        ? [(item as { country: string }).country] : [])
      : [];
    const researchEnrichment = new Map<string, ConfirmedProfessorResearchResult>();
    try {
      const saved = JSON.parse(await readFile(resolve(directory, RESEARCH_ENRICHMENT_FILE), 'utf8')) as { schemaVersion?: unknown; professors?: unknown };
      if (saved.schemaVersion === 1 && Array.isArray(saved.professors)) {
        const targets = parseConfirmedProfessorReports(reportInputs, localDecision, diagnosticInputs).professors;
        for (const target of targets) {
          const row = saved.professors.find((item) => item && typeof item === 'object' && (item as { stableId?: unknown }).stableId === target.stableId);
          const validated = validatedResearchEnrichmentRow(row, target);
          if (validated) researchEnrichment.set(target.stableId, validated);
        }
      }
    } catch { /* Existing confirmed-professor reports remain available without enrichment data. */ }
    return {
      status: 'available',
      source: `${reportInputs.length + diagnosticInputs.length + (localDecision ? 1 : 0)} local preview reports`,
      countriesCovered: coveredCountries.size,
      skippedCountries: skipped,
      result: parseConfirmedProfessorReports(reportInputs, localDecision, diagnosticInputs),
      researchEnrichment,
    };
  } catch { return { status: 'error' }; }
}
