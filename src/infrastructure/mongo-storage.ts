import { MongoClient } from 'mongodb';
import type { Collection, Db, Document } from 'mongodb';
import { parseApplicantProfile, type ApplicantProfile } from '../domain/applicant-profile.ts';
import type { OutreachAttempt, ProfessorCandidate } from '../domain/outreach-queue.ts';

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

export interface GradReachRepositories {
  profiles: ApplicantProfileRepository;
  candidates: ProfessorCandidateRepository;
  attempts: OutreachAttemptRepository;
}

/** Creates repositories without creating indexes as a side effect of application startup. */
export function createRepositories(db: Db): GradReachRepositories {
  return {
    profiles: new ApplicantProfileRepository(db.collection<StoredProfile>('applicant_profiles')),
    candidates: new ProfessorCandidateRepository(db.collection<StoredCandidate>('professor_candidates')),
    attempts: new OutreachAttemptRepository(db.collection<StoredAttempt>('outreach_attempts')),
  };
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
