import { MongoClient } from 'mongodb';
import type { Collection, Db, Document } from 'mongodb';
import { parseApplicantProfile, type ApplicantProfile } from '../domain/applicant-profile.ts';
import type { CandidateEvidenceTriage, OutreachAttempt, ProfessorCandidate, SchedulerControl } from '../domain/outreach-queue.ts';
import type { ProgramAssessment, ProgramRecord } from '../domain/program-assessment.ts';
import type { DiscoveryEvidenceCheck, DiscoveryRun, DiscoverySchedule } from '../application/automatic-discovery.ts';
import { MAX_SAVED_LEADS_PER_REPROCESS_RUN, type SavedLeadReprocessResult, type SavedLeadReprocessRun } from '../domain/saved-lead-reprocessing.ts';
import { getLocalDateKey } from '../domain/outreach-queue.ts';
import { assertDiscoveryCollectionsMigrated } from './discovery-collection-migration.ts';
import type { ConfirmedProfessor } from '../application/confirmed-professors.ts';

interface StoredProfile extends Document {
  _id: string;
  profile: ApplicantProfile;
  updatedAt: Date;
}

interface StoredCandidate extends Document {
  _id: string;
  candidate: ProfessorCandidate;
  normalizedEmail?: string;
  lastReprocessedRunId?: string;
  updatedAt: Date;
}

interface StoredCandidateTriage extends Document {
  _id: string;
  triage: CandidateEvidenceTriage;
  updatedAt: Date;
}

interface StoredAttempt extends Document {
  _id: string;
  attempt: OutreachAttempt;
  updatedAt: Date;
}

interface StoredProgram extends Document {
  _id: string;
  program: ProgramRecord;
  updatedAt: Date;
}

interface StoredProgramAssessment extends Document {
  _id: string;
  assessment: ProgramAssessment;
  updatedAt: Date;
}

interface StoredSchedulerControl extends Document {
  _id: 'daily-scheduler';
  control: SchedulerControl;
  updatedAt: Date;
}

interface StoredDiscoverySchedule extends Document { _id: 'automatic-discovery'; schedule: DiscoverySchedule; updatedAt: Date; }
interface StoredDiscoveryRun extends Document { _id: string; run: DiscoveryRun; updatedAt: Date; }
interface StoredDiscoveryCheck extends Document { _id: string; check: DiscoveryEvidenceCheck; updatedAt: Date; }
interface StoredSavedLeadReprocessRun extends Document { _id: string; run: SavedLeadReprocessRun; updatedAt: Date; }
interface StoredConfirmedProfessor extends Document {
  _id: string;
  stableId: string;
  canonicalProfileUrl: string;
  normalizedIdentity: string;
  professor: Omit<ConfirmedProfessor, 'localOwnerDecision' | 'approved' | 'queued' | 'sent'>;
  researchOutcome?: 'matched' | 'evidence_found_no_match' | 'no_research_evidence' | 'fetch_failed' | 'not_evaluated';
  ownerDecision: 'pending' | 'accepted' | 'rejected';
  approved: boolean;
  queued: boolean;
  sent: boolean;
  updatedAt: Date;
}

export class ConfirmedProfessorRepository {
  private readonly collection: Collection<StoredConfirmedProfessor>;
  constructor(collection: Collection<StoredConfirmedProfessor>) { this.collection = collection; }
  async upsert(professor: ConfirmedProfessor & { researchOutcome?: StoredConfirmedProfessor['researchOutcome'] }): Promise<'inserted' | 'updated'> {
    const profile = new URL(professor.officialProfileUrl);
    profile.search = ''; profile.hash = '';
    const canonicalProfileUrl = profile.toString();
    const normalizedIdentity = `${professor.name.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}|${professor.institution.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
    const existing = await this.collection.findOne({ $or: [{ _id: professor.stableId }, { canonicalProfileUrl }, { normalizedIdentity }] }, { projection: { _id: 1, ownerDecision: 1 } });
    const id = existing?._id ?? professor.stableId;
    const persisted = { ...professor, stableId: existing?.stableId ?? professor.stableId };
    delete (persisted as Partial<ConfirmedProfessor>).localOwnerDecision;
    delete (persisted as Partial<ConfirmedProfessor>).approved;
    delete (persisted as Partial<ConfirmedProfessor>).queued;
    delete (persisted as Partial<ConfirmedProfessor>).sent;
    const setValues: Record<string, unknown> = { stableId: existing?.stableId ?? professor.stableId, canonicalProfileUrl, normalizedIdentity, professor: persisted, updatedAt: new Date() };
    if (existing?.ownerDecision === 'pending' && professor.localOwnerDecision === 'accepted_local_only') setValues.ownerDecision = 'accepted';
    const setOnInsert: Record<string, unknown> = { _id: id, approved: false, queued: false, sent: false };
    if (!existing) setOnInsert.ownerDecision = professor.localOwnerDecision === 'accepted_local_only' ? 'accepted' : 'pending';
    const update = {
      $set: { ...setValues, ...(professor.researchOutcome ? { researchOutcome: professor.researchOutcome } : {}) },
      $setOnInsert: setOnInsert,
    };
    const result = await this.collection.updateOne({ _id: id }, update as never, { upsert: !existing });
    return result.upsertedCount ? 'inserted' : 'updated';
  }
}

export class SavedLeadReprocessRunRepository {
  private readonly collection: Collection<StoredSavedLeadReprocessRun>;
  constructor(collection: Collection<StoredSavedLeadReprocessRun>) { this.collection = collection; }
  async start(run: SavedLeadReprocessRun): Promise<void> {
    await this.collection.insertOne({ _id: run.id, run, updatedAt: new Date() });
  }
  async recordResult(runId: string, result: SavedLeadReprocessResult): Promise<boolean> {
    const updated = await this.collection.updateOne(
      {
        _id: runId, 'run.state': 'running', 'run.results.candidateId': { $ne: result.candidateId },
        $expr: { $lt: [{ $size: '$run.results' }, MAX_SAVED_LEADS_PER_REPROCESS_RUN] },
      },
      { $push: { 'run.results': result }, $set: { updatedAt: new Date() } } as never,
    );
    if (updated.modifiedCount === 1) return true;
    const existing = await this.collection.findOne({ _id: runId, 'run.results.candidateId': result.candidateId }, { projection: { _id: 1 } });
    return Boolean(existing);
  }
  async finish(run: SavedLeadReprocessRun): Promise<void> {
    await this.collection.updateOne({ _id: run.id }, { $set: { run, updatedAt: new Date() } });
  }
  async get(runId: string): Promise<SavedLeadReprocessRun | undefined> {
    return (await this.collection.findOne({ _id: runId }, { projection: { run: 1 } }))?.run;
  }
  async list(limit = 20): Promise<SavedLeadReprocessRun[]> {
    return (await this.collection.find().sort({ 'run.startedAt': -1 }).limit(Math.max(1, Math.min(100, limit))).toArray()).map((record) => record.run);
  }
}

export class AutomaticDiscoveryScheduleRepository {
  private readonly collection: Collection<StoredDiscoverySchedule>;
  constructor(collection: Collection<StoredDiscoverySchedule>) { this.collection = collection; }
  async get(): Promise<DiscoverySchedule | undefined> { return (await this.collection.findOne({ _id: 'automatic-discovery' }))?.schedule; }
  async save(schedule: DiscoverySchedule): Promise<void> {
    await this.collection.updateOne({ _id: 'automatic-discovery' }, { $set: { schedule, updatedAt: new Date() }, $setOnInsert: { _id: 'automatic-discovery' } }, { upsert: true });
  }
}

export class AutomaticDiscoveryRunRepository {
  private readonly collection: Collection<StoredDiscoveryRun>;
  constructor(collection: Collection<StoredDiscoveryRun>) { this.collection = collection; }
  async list(limit: number): Promise<DiscoveryRun[]> {
    return (await this.collection.find().sort({ 'run.startedAt': -1 }).limit(Math.max(1, Math.min(100, limit))).toArray()).map((item) => item.run);
  }
  async claim(run: DiscoveryRun): Promise<boolean> {
    try { await this.collection.insertOne({ _id: run.id, run, updatedAt: new Date() }); return true; }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) return false; throw error; }
  }
  async finish(run: DiscoveryRun): Promise<void> {
    await this.collection.updateOne({ _id: run.id, 'run.state': 'running' }, { $set: { run, updatedAt: new Date() } });
  }
  async recordDiagnostic(runId: string, diagnostic: NonNullable<DiscoveryRun['resultDiagnostics']>[number]): Promise<void> {
    const safe = sanitizeStoredDiscoveryDiagnostic(diagnostic);
    if (!safe) return;
    const resultNumber = diagnostic.resultNumber;
    await this.collection.updateOne(
      { _id: runId, 'run.state': 'running', 'run.resultDiagnostics.resultNumber': resultNumber },
      { $set: { 'run.resultDiagnostics.$': safe, updatedAt: new Date() } },
    ).then(async (result) => {
      if (result.matchedCount) return;
      await this.collection.updateOne(
        { _id: runId, 'run.state': 'running', 'run.resultDiagnostics.resultNumber': { $ne: resultNumber } },
        { $push: { 'run.resultDiagnostics': safe } as never, $set: { updatedAt: new Date() } },
      );
    });
  }
  async recordCountryOutcome(runId: string, outcome: NonNullable<DiscoveryRun['countryOutcomes']>[number]): Promise<void> {
    if (runId.length > 512 || !outcome.country.trim() || outcome.country.length > 80 || outcome.runId.length > 512) return;
    const current = await this.collection.findOne({ _id: runId, 'run.state': 'running' }, { projection: { 'run.countryOutcomes': 1 } });
    if (!current) return;
    const outcomes = current.run.countryOutcomes ?? [];
    const updated = [...outcomes.filter((item) => item.country !== outcome.country), outcome];
    await this.collection.updateOne({ _id: runId, 'run.state': 'running' }, { $set: { 'run.countryOutcomes': updated, updatedAt: new Date() } });
  }
  async recordProgress(runId: string, counts: DiscoveryRun['counts']): Promise<void> {
    const bounded = Object.fromEntries(Object.entries(counts).filter(([key, value]) =>
      ['searches', 'results', 'saved', 'duplicates', 'rejections', 'fetchFailures', 'inspected', 'inspectionFailures', 'pageFetches', 'professorsSaved', 'leadsSaved'].includes(key) && Number.isInteger(value) && value >= 0,
    ));
    await this.collection.updateOne({ _id: runId, 'run.state': 'running' }, { $set: { 'run.counts': bounded, updatedAt: new Date() } });
  }
  async recoverInterrupted(before: string, finishedAt: string): Promise<number> {
    const result = await this.collection.updateMany(
      { 'run.state': 'running', 'run.scheduledFor': { $lt: before } },
      { $set: { 'run.state': 'failed', 'run.failureCode': 'worker_interrupted', 'run.completedAt': finishedAt, updatedAt: new Date() } },
    );
    return result.modifiedCount;
  }
}

const STORED_DISCOVERY_REASONS = new Set(['exact_host', 'title', 'excerpt', 'duplicate', 'passed_evidence_gates', 'timeout', 'dns_tls', 'rate_limited', 'http_status', 'rejected_redirect', 'disallowed_host', 'invalid_content', 'network_error', 'mongodb_server_error', 'invalid_request', 'missing_configuration', 'not_professor_profile', 'no_named_professor_identity', 'no_official_research_evidence', 'research_interest_mismatch', 'invalid_search_result', 'duplicate_saved_lead', 'duplicate_official_profile', 'official_page_fetch_failed', 'page_fetch_limit', 'identity_not_established', 'research_evidence_missing', 'passed_all_gates']);
function sanitizeStoredDiscoveryDiagnostic(value: NonNullable<DiscoveryRun['resultDiagnostics']>[number]): NonNullable<DiscoveryRun['resultDiagnostics']>[number] | undefined {
  if (!Number.isInteger(value.resultNumber) || value.resultNumber < 1 || value.resultNumber > 3 || !STORED_DISCOVERY_REASONS.has(value.reason)) return undefined;
  const savedRecords = (Array.isArray(value.savedRecords) ? value.savedRecords : []).slice(0, 2).flatMap((item) =>
    (item.kind === 'confirmed_professor' || item.kind === 'qualified_lead') && /^[A-Za-z0-9:_-]{1,160}$/.test(item.id)
      ? [{ kind: item.kind, id: item.id }] : []);
  const safeCount = (count: number | undefined, max: number) => Number.isInteger(count) && count! >= 0 && count! <= max ? count : undefined;
  const selected = <TReason extends string>(items: Array<{ rank: number; reasons: TReason[] }>, maxRank: number, allowed: readonly TReason[]) => items.slice(0, maxRank).flatMap((item) => {
    const reasons = item.reasons.filter((reason) => allowed.includes(reason)).slice(0, 6);
    return Number.isInteger(item.rank) && item.rank >= 1 && item.rank <= maxRank && reasons.length ? [{ rank: item.rank, reasons }] : [];
  });
  const rejections = (items: Array<{ reason: string; count: number }> | undefined, allowed: string[]) => (items ?? []).slice(0, 2).flatMap((item) =>
    allowed.includes(item.reason) && Number.isInteger(item.count) && item.count >= 1 && item.count <= 100 ? [item] : []);
  return {
    resultNumber: value.resultNumber,
    stage: ['result_validation', 'professor_evidence', 'official_page_fetch', 'duplicate_check', 'interest_match'].includes(value.stage) ? value.stage : 'result_validation',
    reason: value.reason,
    ...(value.observedHostname && /^[a-z0-9.-]{1,253}$/.test(value.observedHostname) ? { observedHostname: value.observedHostname } : {}),
    ...(typeof value.directoryPageFetched === 'boolean' ? { directoryPageFetched: value.directoryPageFetched } : {}),
    ...(safeCount(value.sameHostProfileLinksFound, 100) !== undefined ? { sameHostProfileLinksFound: value.sameHostProfileLinksFound } : {}),
    ...(safeCount(value.sameHostProfileLinksConsidered, 100) !== undefined ? { sameHostProfileLinksConsidered: value.sameHostProfileLinksConsidered } : {}),
    ...(safeCount(value.sameHostProfileLinksFetched, 10) !== undefined ? { sameHostProfileLinksFetched: value.sameHostProfileLinksFetched } : {}),
    ...(value.selectedProfileLinks?.length ? { selectedProfileLinks: selected(value.selectedProfileLinks, 10, ['named_link_text', 'named_faculty_context', 'profile_url_pattern', 'faculty_card_context', 'profile_label', 'academic_role']) } : {}),
    ...(typeof value.professorIdentityEstablished === 'boolean' ? { professorIdentityEstablished: value.professorIdentityEstablished } : {}),
    ...(safeCount(value.linkedResearchPagesConsidered, 100) !== undefined ? { linkedResearchPagesConsidered: value.linkedResearchPagesConsidered } : {}),
    ...(safeCount(value.linkedResearchPagesFound, 100) !== undefined ? { linkedResearchPagesFound: value.linkedResearchPagesFound } : {}),
    ...(safeCount(value.linkedResearchPagesFetched, 5) !== undefined ? { linkedResearchPagesFetched: value.linkedResearchPagesFetched } : {}),
    ...(value.linkedResearchPagesSelected?.length ? { linkedResearchPagesSelected: selected(value.linkedResearchPagesSelected, 5, ['research_anchor_text', 'research_url_pattern', 'research_section_context']) } : {}),
    ...(rejections(value.profileLinkRejections, ['excluded_navigation_or_nonacademic', 'insufficient_profile_signals']).length ? { profileLinkRejections: rejections(value.profileLinkRejections, ['excluded_navigation_or_nonacademic', 'insufficient_profile_signals']) as NonNullable<NonNullable<DiscoveryRun['resultDiagnostics']>[number]['profileLinkRejections']> } : {}),
    ...(rejections(value.researchPageLinkRejections, ['non_research_destination', 'no_research_signal']).length ? { researchPageLinkRejections: rejections(value.researchPageLinkRejections, ['non_research_destination', 'no_research_signal']) as NonNullable<NonNullable<DiscoveryRun['resultDiagnostics']>[number]['researchPageLinkRejections']> } : {}),
    ...(typeof value.relevantOfficialResearchEvidenceEstablished === 'boolean' ? { relevantOfficialResearchEvidenceEstablished: value.relevantOfficialResearchEvidenceEstablished } : {}),
    ...(typeof value.identityConfirmed === 'boolean' ? { identityConfirmed: value.identityConfirmed } : {}),
    ...(typeof value.researchEvidenceFound === 'boolean' ? { researchEvidenceFound: value.researchEvidenceFound } : {}),
    ...(typeof value.interestMatched === 'boolean' || value.interestMatched === null ? { interestMatched: value.interestMatched } : {}),
    ...(savedRecords.length ? { savedRecords } : {}),
    ...(Number.isInteger(value.statusCode) && value.statusCode! >= 100 && value.statusCode! <= 599 ? { statusCode: value.statusCode } : {}),
    ...(value.networkCode && /^[A-Z0-9_]{1,40}$/.test(value.networkCode) ? { networkCode: value.networkCode } : {}),
  };
}

export class AutomaticDiscoveryEvidenceCheckRepository {
  private readonly collection: Collection<StoredDiscoveryCheck>;
  constructor(collection: Collection<StoredDiscoveryCheck>) { this.collection = collection; }
  async has(candidateId: string, runId: string): Promise<boolean> { return Boolean(await this.collection.findOne({ _id: `${runId}:${candidateId}` }, { projection: { _id: 1 } })); }
  async save(check: DiscoveryEvidenceCheck): Promise<void> {
    await this.collection.updateOne({ _id: check.id }, { $setOnInsert: { _id: check.id, check, updatedAt: new Date() } }, { upsert: true });
  }
  async list(limit = 100): Promise<DiscoveryEvidenceCheck[]> {
    return (await this.collection.find().sort({ 'check.checkedAt': -1 }).limit(Math.max(1, Math.min(100, limit))).toArray()).map((item) => item.check);
  }
}

export class ApplicantProfileRepository {
  private readonly collection: Collection<StoredProfile>;

  constructor(collection: Collection<StoredProfile>) {
    this.collection = collection;
  }

  async get(profileId: string): Promise<ApplicantProfile | undefined> {
    const stored = await this.collection.findOne({ _id: profileId });
    return stored ? parseApplicantProfile(stored.profile) : undefined;
  }

  async save(profileId: string, profile: ApplicantProfile): Promise<void> {
    const validatedProfile = parseApplicantProfile(profile);
    await this.collection.replaceOne(
      { _id: profileId },
      { _id: profileId, profile: validatedProfile, updatedAt: new Date() },
      { upsert: true },
    );
  }

  async delete(profileId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: profileId });
    return result.deletedCount === 1;
  }
}

export class ProfessorCandidateRepository {
  private readonly collection: Collection<StoredCandidate>;

  constructor(collection: Collection<StoredCandidate>) {
    this.collection = collection;
  }

  async get(candidateId: string): Promise<ProfessorCandidate | undefined> {
    const stored = await this.collection.findOne({ _id: candidateId });
    return stored?.candidate;
  }

  async list(): Promise<ProfessorCandidate[]> {
    const documents = await this.collection.find().sort({ 'candidate.priority': -1, 'candidate.name': 1 }).toArray();
    return documents.map((document) => document.candidate);
  }

  /** Returns only stable IDs marked by a run, for reconciling a write before its outcome record. */
  async listReprocessedLeadIds(runId: string): Promise<string[]> {
    return (await this.collection.find({ lastReprocessedRunId: runId }, { projection: { _id: 1 } }).toArray()).map(({ _id }) => String(_id));
  }

  async save(candidate: ProfessorCandidate): Promise<void> {
    const email = candidate.officialEmail?.trim().toLowerCase();
    const document: StoredCandidate = {
      _id: candidate.id,
      candidate,
      updatedAt: new Date(),
      ...(email ? { normalizedEmail: email } : {}),
    };
    await this.collection.replaceOne({ _id: candidate.id }, document, { upsert: true });
  }

  /** Adds newly validated discovery evidence without replacing review, approval, or outreach fields. */
  async appendValidatedResearchEvidence(input: {
    candidateId: string;
    expectedOfficialProfileUrl?: string;
    expectedProfessorName?: string;
    officialProfileUrl: string;
    professorName: string;
    leadName: string;
    runId: string;
    evidence: NonNullable<ProfessorCandidate['discoveryEvidence']>;
  }): Promise<boolean> {
    const filter: Record<string, unknown> = {
      _id: input.candidateId,
      'candidate.status': { $in: ['researching', 'needs-evidence', 'ready-for-review'] },
      'candidate.approvedForSending': { $ne: true },
      'candidate.discoveryReview': { $exists: false },
      ...(input.expectedOfficialProfileUrl === undefined
        ? { 'candidate.officialProfileUrl': { $exists: false } }
        : { 'candidate.officialProfileUrl': input.expectedOfficialProfileUrl }),
      ...(input.expectedProfessorName === undefined
        ? { 'candidate.professorName': { $exists: false } }
        : { 'candidate.professorName': input.expectedProfessorName }),
    };
    const result = await this.collection.updateOne(filter, {
      $set: {
        'candidate.name': input.leadName,
        'candidate.professorName': input.professorName,
        'candidate.leadType': 'professor_profile',
        'candidate.officialProfileUrl': input.officialProfileUrl,
        lastReprocessedRunId: input.runId,
        updatedAt: new Date(),
      },
      $addToSet: { 'candidate.discoveryEvidence': { $each: input.evidence } },
    });
    return result.modifiedCount === 1;
  }

  async delete(candidateId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: candidateId });
    return result.deletedCount === 1;
  }

  async markSent(candidateId: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: candidateId, 'candidate.status': 'approved', 'candidate.approvedForSending': true },
      { $set: { 'candidate.status': 'sent', 'candidate.approvedForSending': false, updatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }
}

export class CandidateEvidenceTriageRepository {
  private readonly collection: Collection<StoredCandidateTriage>;

  constructor(collection: Collection<StoredCandidateTriage>) {
    this.collection = collection;
  }

  async get(candidateId: string): Promise<CandidateEvidenceTriage | undefined> {
    return (await this.collection.findOne({ _id: candidateId }))?.triage;
  }

  async list(): Promise<CandidateEvidenceTriage[]> {
    const records = await this.collection.find().sort({ 'triage.triagedAt': -1 }).toArray();
    return records.map((record) => record.triage);
  }

  async save(triage: CandidateEvidenceTriage): Promise<void> {
    await this.collection.replaceOne(
      { _id: triage.candidateId },
      { _id: triage.candidateId, triage, updatedAt: new Date() },
      { upsert: true },
    );
  }
}

export function outreachAttemptId(candidateId: string, scheduledFor: string): string {
  const scheduledAt = new Date(scheduledFor);
  if (Number.isNaN(scheduledAt.getTime())) throw new Error('attempt.scheduledFor must be a valid date');
  return `${candidateId}:${scheduledAt.toISOString()}`;
}

export class OutreachAttemptRepository {
  private readonly collection: Collection<StoredAttempt>;

  constructor(collection: Collection<StoredAttempt>) {
    this.collection = collection;
  }

  async listAll(): Promise<OutreachAttempt[]> {
    const documents = await this.collection.find().sort({ 'attempt.scheduledFor': 1 }).toArray();
    return documents.map((document) => document.attempt);
  }

  async listForCandidate(candidateId: string): Promise<OutreachAttempt[]> {
    const documents = await this.collection
      .find({ 'attempt.candidateId': candidateId })
      .sort({ 'attempt.scheduledFor': 1 })
      .toArray();
    return documents.map((document) => document.attempt);
  }

  /** Upserts by candidate and scheduled instant, so a retry cannot create a second audit row. */
  async record(attempt: OutreachAttempt): Promise<void> {
    const scheduledAt = new Date(attempt.scheduledFor);
    const attemptId = outreachAttemptId(attempt.candidateId, attempt.scheduledFor);
    const scheduledFor = scheduledAt.toISOString();
    const normalizedAttempt = { ...attempt, scheduledFor };
    await this.collection.updateOne(
      { _id: attemptId },
      { $setOnInsert: { _id: attemptId, attempt: normalizedAttempt, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  /** Claims one attempt exactly once; stale or active sends cannot be picked by another worker. */
  async claimForDelivery(attempt: OutreachAttempt, now: string, maxAttempts: number): Promise<OutreachAttempt | undefined> {
    const id = outreachAttemptId(attempt.candidateId, attempt.scheduledFor);
    const claimedAt = new Date(now);
    if (Number.isNaN(claimedAt.getTime())) throw new Error('now must be a valid date');
    const update = await this.collection.updateOne({
      _id: id,
      $or: [
        { 'attempt.state': 'queued' },
        { 'attempt.state': 'failed', 'attempt.nextAttemptAt': { $lte: claimedAt.toISOString() }, 'attempt.deliveryAttempts': { $lt: maxAttempts } },
        { 'attempt.state': 'failed', 'attempt.nextAttemptAt': { $lte: claimedAt.toISOString() }, 'attempt.deliveryAttempts': { $exists: false } },
      ],
    }, {
      $set: { 'attempt.state': 'sending', 'attempt.lastAttemptAt': claimedAt.toISOString(), updatedAt: claimedAt },
      $inc: { 'attempt.deliveryAttempts': 1 },
      $unset: { 'attempt.nextAttemptAt': '' },
    });
    if (update.modifiedCount !== 1) return undefined;
    return (await this.collection.findOne({ _id: id }))?.attempt;
  }

  async updateDelivery(attempt: OutreachAttempt): Promise<boolean> {
    const id = outreachAttemptId(attempt.candidateId, attempt.scheduledFor);
    const result = await this.collection.updateOne(
      { _id: id, 'attempt.state': 'sending' },
      { $set: { attempt, updatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }

  async rejectQueued(attempt: OutreachAttempt, failureCode: string): Promise<void> {
    await this.collection.updateOne(
      { _id: outreachAttemptId(attempt.candidateId, attempt.scheduledFor), 'attempt.state': { $in: ['queued', 'failed'] } },
      { $set: { 'attempt.state': 'failed', 'attempt.failureCode': failureCode, updatedAt: new Date() }, $unset: { 'attempt.nextAttemptAt': '' } },
    );
  }

  async releaseClaim(attempt: OutreachAttempt): Promise<void> {
    await this.collection.updateOne(
      { _id: outreachAttemptId(attempt.candidateId, attempt.scheduledFor), 'attempt.state': 'sending' },
      { $set: { 'attempt.state': 'queued', updatedAt: new Date() } },
    );
  }

  async recoverStaleSending(before: string): Promise<number> {
    const result = await this.collection.updateMany(
      { 'attempt.state': 'sending', 'attempt.lastAttemptAt': { $lte: before } },
      { $set: { 'attempt.state': 'uncertain', 'attempt.failureCode': 'delivery-interrupted-unknown-outcome', updatedAt: new Date() }, $unset: { 'attempt.nextAttemptAt': '' } },
    );
    return result.modifiedCount;
  }

  async recordManualOutcome(input: {
    candidateId: string;
    replyStatus: NonNullable<OutreachAttempt['replyStatus']>;
    followUpStatus: NonNullable<OutreachAttempt['followUpStatus']>;
    recordedAt: string;
    followUpScheduledFor?: string;
  }): Promise<boolean> {
    const recordedAt = new Date(input.recordedAt);
    if (Number.isNaN(recordedAt.getTime())) throw new Error('recordedAt must be a valid date');
    if (input.followUpScheduledFor && Number.isNaN(new Date(input.followUpScheduledFor).getTime())) throw new Error('followUpScheduledFor must be a valid date');
    if (input.followUpStatus === 'scheduled' && !input.followUpScheduledFor) throw new Error('A scheduled follow-up requires followUpScheduledFor');
    const lastSent = await this.collection.findOne(
      { 'attempt.candidateId': input.candidateId, 'attempt.state': 'sent' },
      { sort: { 'attempt.sentAt': -1 } },
    );
    if (!lastSent) return false;
    const result = await this.collection.updateOne({ _id: lastSent._id, 'attempt.state': 'sent' }, {
      $set: {
        'attempt.replyStatus': input.replyStatus,
        'attempt.replyRecordedAt': recordedAt.toISOString(),
        'attempt.followUpStatus': input.followUpStatus,
        ...(input.followUpScheduledFor ? { 'attempt.followUpScheduledFor': new Date(input.followUpScheduledFor).toISOString() } : {}),
        updatedAt: recordedAt,
      },
      ...(input.followUpScheduledFor ? {} : { $unset: { 'attempt.followUpScheduledFor': '' } }),
    });
    return result.modifiedCount === 1;
  }
}

export class ProgramRepository {
  private readonly collection: Collection<StoredProgram>;

  constructor(collection: Collection<StoredProgram>) { this.collection = collection; }

  async get(programId: string): Promise<ProgramRecord | undefined> {
    return (await this.collection.findOne({ _id: programId }))?.program;
  }

  async list(): Promise<ProgramRecord[]> {
    const documents = await this.collection.find().sort({ 'program.country': 1, 'program.institution': 1, 'program.name': 1 }).toArray();
    return documents.map((document) => document.program);
  }

  async save(program: ProgramRecord): Promise<void> {
    await this.collection.replaceOne({ _id: program.id }, { _id: program.id, program, updatedAt: new Date() }, { upsert: true });
  }

  async delete(programId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: programId });
    return result.deletedCount === 1;
  }
}

export class ProgramAssessmentRepository {
  private readonly collection: Collection<StoredProgramAssessment>;

  constructor(collection: Collection<StoredProgramAssessment>) { this.collection = collection; }

  async latest(programId: string): Promise<ProgramAssessment | undefined> {
    const stored = await this.collection.find({ 'assessment.programId': programId })
      .sort({ 'assessment.assessedAt': -1 }).limit(1).next();
    return stored?.assessment;
  }

  /** Assessment timestamps form the idempotency key, retaining each dated reassessment. */
  async save(assessment: ProgramAssessment): Promise<void> {
    const assessedAt = new Date(assessment.assessedAt);
    if (Number.isNaN(assessedAt.getTime())) throw new Error('assessment.assessedAt must be a valid date');
    const timestamp = assessedAt.toISOString();
    const id = `${assessment.programId}:${timestamp}`;
    const normalizedAssessment = { ...assessment, assessedAt: timestamp };
    await this.collection.replaceOne({ _id: id }, { _id: id, assessment: normalizedAssessment, updatedAt: new Date() }, { upsert: true });
  }
}

export class SchedulerControlRepository {
  private readonly collection: Collection<StoredSchedulerControl>;

  constructor(collection: Collection<StoredSchedulerControl>) { this.collection = collection; }

  async get(): Promise<SchedulerControl | undefined> {
    return (await this.collection.findOne({ _id: 'daily-scheduler' }))?.control;
  }

  async save(control: SchedulerControl): Promise<void> {
    if (!Number.isInteger(control.dailyLimit) || control.dailyLimit < 1 || control.dailyLimit > 5) {
      throw new Error('dailyLimit must be an integer from 1 to 5');
    }
    if (typeof control.paused !== 'boolean') throw new Error('paused must be a boolean');
    try { new Intl.DateTimeFormat('en', { timeZone: control.timeZone }); }
    catch { throw new Error('timeZone must be a valid IANA timezone'); }
    await this.collection.updateOne(
      { _id: 'daily-scheduler' },
      { $set: { control, updatedAt: new Date() }, $setOnInsert: { _id: 'daily-scheduler' } },
      { upsert: true },
    );
  }

  /** Atomically reserves one message slot in the configured local calendar day. */
  async reserveDailySend(now: string): Promise<boolean> {
    const instant = new Date(now);
    if (Number.isNaN(instant.getTime())) throw new Error('now must be a valid date');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const stored = await this.collection.findOne({ _id: 'daily-scheduler' });
      if (!stored || stored.control.paused) return false;
      const control = stored.control;
      if (!Number.isInteger(control.dailyLimit) || control.dailyLimit < 1 || control.dailyLimit > 5) return false;
      const localDate = getLocalDateKey(instant.toISOString(), control.timeZone);
      if (stored.deliveryDate === localDate) {
        if (!Number.isInteger(stored.deliveryCount) || stored.deliveryCount >= control.dailyLimit) return false;
        const increment = await this.collection.updateOne(
          { _id: 'daily-scheduler', 'control.paused': false, 'control.dailyLimit': control.dailyLimit, deliveryDate: localDate, deliveryCount: { $lt: control.dailyLimit } },
          { $inc: { deliveryCount: 1 }, $set: { updatedAt: instant } },
        );
        if (increment.modifiedCount === 1) return true;
      } else {
        const reset = await this.collection.updateOne(
          { _id: 'daily-scheduler', 'control.paused': false, 'control.dailyLimit': control.dailyLimit, $or: [{ deliveryDate: { $ne: localDate } }, { deliveryDate: { $exists: false } }] },
          { $set: { deliveryDate: localDate, deliveryCount: 1, updatedAt: instant } },
        );
        if (reset.modifiedCount === 1) return true;
      }
    }
    return false;
  }
}

export interface GradReachRepositories {
  profiles: ApplicantProfileRepository;
  candidates: ProfessorCandidateRepository;
  evidenceTriage: CandidateEvidenceTriageRepository;
  attempts: OutreachAttemptRepository;
  programs: ProgramRepository;
  assessments: ProgramAssessmentRepository;
  schedulerControl: SchedulerControlRepository;
  discoverySchedule: AutomaticDiscoveryScheduleRepository;
  discoveryRuns: AutomaticDiscoveryRunRepository;
  discoveryChecks: AutomaticDiscoveryEvidenceCheckRepository;
  savedLeadReprocessRuns: SavedLeadReprocessRunRepository;
  confirmedProfessors: ConfirmedProfessorRepository;
}

/** Creates repositories without creating indexes as a side effect of application startup. */
export function createRepositories(db: Db): GradReachRepositories {
  return {
    profiles: new ApplicantProfileRepository(db.collection<StoredProfile>('applicant_profiles')),
    candidates: new ProfessorCandidateRepository(db.collection<StoredCandidate>('discovery_leads')),
    evidenceTriage: new CandidateEvidenceTriageRepository(db.collection<StoredCandidateTriage>('lead_triage_recommendations')),
    attempts: new OutreachAttemptRepository(db.collection<StoredAttempt>('outreach_attempts')),
    programs: new ProgramRepository(db.collection<StoredProgram>('programs')),
    assessments: new ProgramAssessmentRepository(db.collection<StoredProgramAssessment>('program_assessments')),
    schedulerControl: new SchedulerControlRepository(db.collection<StoredSchedulerControl>('outreach_control')),
    discoverySchedule: new AutomaticDiscoveryScheduleRepository(db.collection<StoredDiscoverySchedule>('discovery_schedule')),
    discoveryRuns: new AutomaticDiscoveryRunRepository(db.collection<StoredDiscoveryRun>('discovery_job_runs')),
    discoveryChecks: new AutomaticDiscoveryEvidenceCheckRepository(db.collection<StoredDiscoveryCheck>('discovery_evidence_checks')),
    savedLeadReprocessRuns: new SavedLeadReprocessRunRepository(db.collection<StoredSavedLeadReprocessRun>('saved_lead_reprocess_runs')),
    confirmedProfessors: new ConfirmedProfessorRepository(db.collection<StoredConfirmedProfessor>('confirmed_professors')),
  };
}

/** Creates indexes for program identity and dated assessment history. */
export async function createPhase4Indexes(db: Db): Promise<void> {
  await db.collection<StoredProgram>('programs').createIndex(
    { 'program.country': 1, 'program.institution': 1, 'program.name': 1 }, { name: 'programs_by_country_institution' },
  );
  await db.collection<StoredProgramAssessment>('program_assessments').createIndex(
    { 'assessment.programId': 1, 'assessment.assessedAt': -1 }, { name: 'assessments_by_program_and_date' },
  );
}

/** Run as an explicit deployment step after reviewing the target database. */
export async function createPhase2Indexes(db: Db): Promise<void> {
  await assertDiscoveryCollectionsMigrated(db);
  await db.collection<StoredCandidate>('discovery_leads').createIndex(
    { normalizedEmail: 1 },
    { name: 'unique_normalized_candidate_email', unique: true, sparse: true },
  );
  await db.collection<StoredAttempt>('outreach_attempts').createIndex(
    { 'attempt.scheduledFor': 1 },
    { name: 'attempts_by_scheduled_time' },
  );
  await db.collection<StoredAttempt>('outreach_attempts').createIndex(
    { 'attempt.candidateId': 1 },
    { name: 'attempts_by_candidate' },
  );
}

export interface ConnectedMongoStorage {
  client: MongoClient;
  repositories: GradReachRepositories;
  close(): Promise<void>;
}

export async function connectMongoStorage(
  uri = process.env.MONGODB_URI,
  databaseName?: string,
): Promise<ConnectedMongoStorage> {
  if (!uri?.trim()) throw new Error('MONGODB_URI must be configured before using MongoDB storage');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const selectedDatabase = databaseName ?? process.env.MONGODB_DATABASE;
    const db = selectedDatabase ? client.db(selectedDatabase) : client.db();
    await assertDiscoveryCollectionsMigrated(db);
    return {
      client,
      repositories: createRepositories(db),
      close: () => client.close(),
    };
  } catch (error) {
    try {
      await client.close();
    } catch {
      // Cleanup failures must not replace the connection error and its safe diagnostics.
    }
    throw error;
  }
}
