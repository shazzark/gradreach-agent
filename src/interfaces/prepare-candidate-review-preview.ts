import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchingResearchInterests } from '../application/professor-research-evidence.ts';
import { compareSavedLeadDuplicates, createCandidateReviewPreview, type CandidateReviewIdentity } from '../application/candidate-review-preview.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

const SOURCE_REPORT = 'private-data/discovery-previews/canada-replay-2026-11-09T08-03-15-343Z-52fd304f.json';
const EVALUATION_REPORT = 'private-data/discovery-previews/canada-offline-reevaluation-2026-11-09T08-27-36-003Z-eb7e2168.json';
interface ReplayReport { candidates: Array<{ recordId: string; identity?: { established: boolean; sourceUrl: string; supportingExcerpt: string }; research?: { extractedSourceUrl?: string; supportingExcerpt?: string } }> }
interface EvaluationReport { candidates: Array<{ recordId: string; researchGate: string; matchedInterestCount: number }> }

function normalizeRecordedExcerpt(value: string): string {
  return value.replaceAll('â€™', '’').replaceAll('â€”', '—').replaceAll('â€“', '–');
}

function identityFromExcerpt(excerpt: string, officialProfileUrl: string): CandidateReviewIdentity | undefined {
  const parts = excerpt.split(/\s+[—–-]\s+/u);
  const name = parts[0]?.trim();
  const role = parts[1]?.trim().toLocaleLowerCase('en') ?? '';
  if (!name || !/^[\p{Lu}][\p{L}.'’ -]{1,80}$/u.test(name) || !/\b(assistant|associate|full|adjunct|clinical|emeritus|research) professor\b|\bprofessor\b|\blecturer\b|\breader\b|\binstructor\b/u.test(role)) return undefined;
  return { professorName: name, institution: 'University of Waterloo', officialProfileUrl };
}

async function writePrivateReport(value: unknown): Promise<string> {
  const directory = resolve(process.cwd(), 'private-data', 'discovery-previews');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `candidate-03-owner-review-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

async function run(): Promise<void> {
  let storage: Awaited<ReturnType<typeof connectMongoStorage>> | undefined;
  try {
    const [source, evaluation] = await Promise.all([
      readFile(SOURCE_REPORT, 'utf8').then((value) => JSON.parse(value) as ReplayReport),
      readFile(EVALUATION_REPORT, 'utf8').then((value) => JSON.parse(value) as EvaluationReport),
    ]);
    const saved = source.candidates.find((candidate) => candidate.recordId === 'candidate-03');
    const evaluated = evaluation.candidates.find((candidate) => candidate.recordId === 'candidate-03');
    const profileUrl = 'https://uwaterloo.ca/electrical-computer-engineering/profile/ecreager';
    if (!saved?.identity?.established || saved.identity.sourceUrl !== profileUrl || !saved.research?.supportingExcerpt || saved.research.extractedSourceUrl !== profileUrl || evaluated?.researchGate !== 'matched' || evaluated.matchedInterestCount < 1) {
      process.stdout.write(`${JSON.stringify({ ok: false, duplicateCheck: 'could not verify', errorCode: 'saved_evidence_incomplete' })}\n`);
      process.exitCode = 1;
      return;
    }
    const identity = identityFromExcerpt(saved.identity.supportingExcerpt, profileUrl);
    if (!identity) {
      process.stdout.write(`${JSON.stringify({ ok: false, duplicateCheck: 'could not verify', errorCode: 'identity_evidence_invalid' })}\n`);
      process.exitCode = 1;
      return;
    }

    storage = await connectMongoStorage();
    const profile = await storage.repositories.profiles.get('primary');
    if (!profile) throw new Error('profile_unavailable');
    const interests = [...profile.applicant.target.researchInterests, ...profile.applicant.target.fields];
    const matches = matchingResearchInterests(saved.research.supportingExcerpt, interests);
    if (matches.length === 0) {
      process.stdout.write(`${JSON.stringify({ ok: false, duplicateCheck: 'could not verify', errorCode: 'saved_interest_match_unconfirmed' })}\n`);
      process.exitCode = 1;
      return;
    }
    const leads = await storage.repositories.candidates.list();
    const duplicateCheck = compareSavedLeadDuplicates(identity, leads);
    if (duplicateCheck.result !== 'not found') {
      process.stdout.write(`${JSON.stringify({ ok: true, duplicateCheck: duplicateCheck.result, inspected: leads.length })}\n`);
      return;
    }
    const preview = createCandidateReviewPreview({
      identity,
      recordId: 'candidate-03',
      researchEvidenceQuote: normalizeRecordedExcerpt(saved.research.supportingExcerpt),
      researchEvidenceSourceUrl: saved.research.extractedSourceUrl!,
      checkedLeadCount: leads.length,
    });
    const reportPath = await writePrivateReport({ generatedAt: new Date().toISOString(), mode: 'saved_evidence_and_read_only_duplicate_check', webRequests: 0, mongoWrites: 0, ...preview });
    process.stdout.write(`${JSON.stringify({ ok: true, duplicateCheck: 'not found', inspected: leads.length, reportPath })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, duplicateCheck: 'could not verify', errorCode: safeFailureRecord(error).kind })}\n`);
    process.exitCode = 1;
  } finally { await storage?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();

export { identityFromExcerpt };
