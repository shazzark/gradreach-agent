import './local-env.ts';
import { MongoClient } from 'mongodb';
import type { Collection, Db, Document } from 'mongodb';
import { parseApplicantProfile, type ApplicantProfile } from '../domain/applicant-profile.ts';
import type { CandidateEvidenceTriage, OutreachAttempt, ProfessorCandidate, SchedulerControl } from '../domain/outreach-queue.ts';
import type { ProgramAssessment, ProgramRecord } from '../domain/program-assessment.ts';
import { getLocalDateKey } from '../domain/outreach-queue.ts';

interface StoredProfile extends Document {
  _id: string;
  profile: ApplicantProfile;
  updatedAt: Date;
}

interface StoredCandidate extends Document {
  _id: string;
  candidate: ProfessorCandidate;
  normalizedEmail?: string;
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
}

/** Creates repositories without creating indexes as a side effect of application startup. */
export function createRepositories(db: Db): GradReachRepositories {
  return {
    profiles: new ApplicantProfileRepository(db.collection<StoredProfile>('applicant_profiles')),
    candidates: new ProfessorCandidateRepository(db.collection<StoredCandidate>('professor_candidates')),
    evidenceTriage: new CandidateEvidenceTriageRepository(db.collection<StoredCandidateTriage>('candidate_evidence_triage')),
    attempts: new OutreachAttemptRepository(db.collection<StoredAttempt>('outreach_attempts')),
    programs: new ProgramRepository(db.collection<StoredProgram>('programs')),
    assessments: new ProgramAssessmentRepository(db.collection<StoredProgramAssessment>('program_assessments')),
    schedulerControl: new SchedulerControlRepository(db.collection<StoredSchedulerControl>('outreach_control')),
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
  await db.collection<StoredCandidate>('professor_candidates').createIndex(
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
    return {
      client,
      repositories: createRepositories(db),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
