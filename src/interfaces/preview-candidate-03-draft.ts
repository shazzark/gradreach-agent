import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalAcceptedOutreachDraftPreview, type LocalOutreachDraftPreview } from '../application/outreach-draft.ts';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';
import { matchingResearchInterests } from '../application/professor-research-evidence.ts';

const REPORT_DIRECTORY = resolve(process.cwd(), 'private-data', 'discovery-previews');
const CANDIDATE_ID = 'candidate-03';

interface OwnerReviewReport {
  generatedAt?: string;
  ownerDecision?: string;
  decisionScope?: string;
  mongoSaved?: boolean;
  candidate?: { professorName?: string; institution?: string; officialProfileUrl?: string };
}

interface ReevaluationReport {
  candidates?: Array<{
    recordId?: string;
    identityEstablished?: boolean;
    researchSourceUrl?: string;
    supportingExcerpt?: string;
    researchGate?: string;
  }>;
}

async function latestOwnerReview(): Promise<{ reportName: string; report: OwnerReviewReport } | undefined> {
  const names = (await readdir(REPORT_DIRECTORY)).filter((name) => name.startsWith('candidate-03-owner-review-') && name.endsWith('.json'));
  const entries = await Promise.all(names.map(async (reportName) => {
    try {
      const [contents, details] = await Promise.all([readFile(resolve(REPORT_DIRECTORY, reportName), 'utf8'), stat(resolve(REPORT_DIRECTORY, reportName))]);
      const report = JSON.parse(contents) as OwnerReviewReport;
      return { reportName, report, timestamp: Date.parse(report.generatedAt ?? '') || details.mtimeMs };
    } catch { return undefined; }
  }));
  return entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry!.report.ownerDecision === 'accepted' &&
    entry!.report.decisionScope === 'local_preview_only' && entry!.report.mongoSaved === false)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

async function latestMatchedEvaluation(): Promise<{ reportName: string; record: NonNullable<ReevaluationReport['candidates']>[number] } | undefined> {
  const names = (await readdir(REPORT_DIRECTORY)).filter((name) => name.startsWith('canada-offline-reevaluation-') && name.endsWith('.json'));
  const entries = await Promise.all(names.map(async (reportName) => {
    try {
      const report = JSON.parse(await readFile(resolve(REPORT_DIRECTORY, reportName), 'utf8')) as ReevaluationReport;
      const record = report.candidates?.find((candidate) => candidate.recordId === CANDIDATE_ID);
      return record?.identityEstablished === true && record.researchGate === 'matched' && record.supportingExcerpt && record.researchSourceUrl
        ? { reportName, record } : undefined;
    } catch { return undefined; }
  }));
  return entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((a, b) => b.reportName.localeCompare(a.reportName))[0];
}

async function readProfile(): Promise<ApplicantProfile> {
  const storage = await connectMongoStorage();
  try {
    const profile = await storage.repositories.profiles.get('primary');
    if (!profile) throw new Error('primary_profile_missing');
    return profile;
  } finally { await storage.close(); }
}

function assertOfficialSource(urlValue: string, country: string): void {
  const hosts = (OFFICIAL_HOSTS_BY_REGION as Record<string, readonly string[]>)[country] ?? [];
  try {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname.toLowerCase())) throw new Error();
  } catch { throw new Error('source_not_official'); }
}

async function writePreview(report: LocalOutreachDraftPreview & {
  schemaVersion: 1; mode: 'private_local_unsent_preview'; country: string; officialProfileUrl: string; sourceReport: string; researchEvaluationReport: string;
}): Promise<string> {
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  const filename = `candidate-03-draft-preview-${new Date(report.generatedAt).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
  const path = resolve(REPORT_DIRECTORY, filename);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

export async function createCandidate03DraftPreview(dependencies: {
  profile: ApplicantProfile;
  ownerReview: OwnerReviewReport;
  evaluation: NonNullable<Awaited<ReturnType<typeof latestMatchedEvaluation>>>;
  now?: string;
}): Promise<LocalOutreachDraftPreview> {
  const identity = dependencies.ownerReview.candidate;
  const research = dependencies.evaluation.record;
  if (dependencies.ownerReview.ownerDecision !== 'accepted' || dependencies.ownerReview.decisionScope !== 'local_preview_only' || dependencies.ownerReview.mongoSaved !== false ||
      research.recordId !== CANDIDATE_ID || research.identityEstablished !== true || research.researchGate !== 'matched' ||
      !identity?.professorName || !identity.institution || !identity.officialProfileUrl || !research.researchSourceUrl || !research.supportingExcerpt ||
      identity.officialProfileUrl !== research.researchSourceUrl) throw new Error('candidate_03_local_evidence_incomplete');
  assertOfficialSource(identity.officialProfileUrl, 'Canada');
  assertOfficialSource(research.researchSourceUrl, 'Canada');
  if (!matchingResearchInterests(research.supportingExcerpt, dependencies.profile.applicant.target.researchInterests).length) {
    throw new Error('candidate_03_saved_interest_match_not_confirmed');
  }
  return createLocalAcceptedOutreachDraftPreview({
    candidateId: CANDIDATE_ID,
    professorName: identity.professorName,
    institution: identity.institution,
    country: 'Canada',
    officialProfileUrl: identity.officialProfileUrl,
    researchSourceUrl: research.researchSourceUrl,
    researchExcerpt: research.supportingExcerpt,
    profile: dependencies.profile,
    ownerDecision: { decision: 'accepted', scope: 'local_preview_only', mongoSaved: false },
    identityEstablished: true,
    researchMatchEstablished: true,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
}

async function run(): Promise<void> {
  try {
    const [profile, owner, evaluation] = await Promise.all([readProfile(), latestOwnerReview(), latestMatchedEvaluation()]);
    if (!owner || !evaluation) throw new Error('candidate_03_local_evidence_unavailable');
    const preview = await createCandidate03DraftPreview({ profile, ownerReview: owner.report, evaluation });
    const report = {
      schemaVersion: 1 as const,
      mode: 'private_local_unsent_preview' as const,
      country: 'Canada',
      officialProfileUrl: owner.report.candidate!.officialProfileUrl!,
      sourceReport: owner.reportName,
      researchEvaluationReport: evaluation.reportName,
      ...preview,
    };
    const reportPath = await writePreview(report);
    process.stdout.write(`${JSON.stringify({ ok: true, reportPath, recipientStatus: preview.recipientStatus, approved: preview.approved, queued: preview.queued, sent: preview.sent, mongoWrites: preview.mongoWrites })}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]{3,60}$/.test(error.message) ? error.message : safeFailureRecord(error).kind;
    process.stderr.write(`${JSON.stringify({ ok: false, errorCode: code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
