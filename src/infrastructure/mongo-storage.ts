import './local-env.ts';
import { MongoClient } from 'mongodb';
import type { Collection, Db, Document } from 'mongodb';
import { parseApplicantProfile, type ApplicantProfile } from '../domain/applicant-profile.ts';
import type { OutreachAttempt, ProfessorCandidate, SchedulerControl } from '../domain/outreach-queue.ts';
import type { ProgramAssessment, ProgramRecord } from '../domain/program-assessment.ts';

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
    if (Number.isNaN(scheduledAt.getTime())) throw new Error('attempt.scheduledFor must be a valid date');
    const scheduledFor = scheduledAt.toISOString();
    const attemptId = `${attempt.candidateId}:${scheduledFor}`;
    const normalizedAttempt = { ...attempt, scheduledFor };
    await this.collection.replaceOne(
      { _id: attemptId },
      { _id: attemptId, attempt: normalizedAttempt, updatedAt: new Date() },
      { upsert: true },
    );
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
    await this.collection.replaceOne(
      { _id: 'daily-scheduler' }, { _id: 'daily-scheduler', control, updatedAt: new Date() }, { upsert: true },
    );
  }
}

export interface GradReachRepositories {
  profiles: ApplicantProfileRepository;
  candidates: ProfessorCandidateRepository;
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
