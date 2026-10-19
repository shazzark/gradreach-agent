import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import type { Document } from 'mongodb';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import { createPhase2Indexes, createRepositories } from '../src/infrastructure/mongo-storage.ts';
import type { OutreachAttempt, ProfessorCandidate } from '../src/domain/outreach-queue.ts';

const mongoUri = process.env.MONGODB_TEST_URI;
const examplePath = new URL('../private.profile.example.json', import.meta.url);

function sampleCandidate(id: string, email: string): ProfessorCandidate {
  return {
    id,
    name: `Synthetic Professor ${id}`,
    institution: 'Example University',
    country: 'Example country',
    officialEmail: email,
    status: 'researching',
    approvedForSending: false,
    priority: 1,
  };
}

test('Mongo profile and candidate repositories preserve separate CRUD and index boundaries', {
  skip: !mongoUri ? 'Set MONGODB_TEST_URI to an isolated test deployment to run MongoDB integration checks' : false,
}, async () => {
  const client = new MongoClient(mongoUri!);
  const databaseName = `gradreach_test_${randomUUID().replaceAll('-', '')}`;
  let db;
  try {
    await client.connect();
    db = client.db(databaseName);
    await createPhase2Indexes(db);
    const repositories = createRepositories(db);
    const profile = parseApplicantProfile(JSON.parse(await readFile(examplePath, 'utf8')) as unknown);

    await repositories.profiles.save('synthetic-profile', profile);
    assert.deepEqual(await repositories.profiles.get('synthetic-profile'), profile);

    await repositories.candidates.save(sampleCandidate('candidate-a', 'a@example.edu'));
    await repositories.candidates.save(sampleCandidate('candidate-b', 'b@example.edu'));
    assert.deepEqual((await repositories.candidates.list()).map((candidate) => candidate.id), ['candidate-a', 'candidate-b']);
    assert.deepEqual(await repositories.candidates.get('candidate-a'), sampleCandidate('candidate-a', 'a@example.edu'));
    await assert.rejects(
      repositories.candidates.save(sampleCandidate('candidate-c', ' A@EXAMPLE.edu ')),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 11000,
    );
    assert.equal(await repositories.candidates.delete('candidate-a'), true);

    const attempt: OutreachAttempt = {
      candidateId: 'candidate-b',
      recipientEmail: 'b@example.edu',
      scheduledFor: '2026-10-19T10:00:00+01:00',
      state: 'queued',
    };
    await repositories.attempts.record(attempt);
    await repositories.attempts.record({ ...attempt, scheduledFor: '2026-10-19T09:00:00Z', state: 'sent' });
    assert.deepEqual(await repositories.attempts.listAll(), [{ ...attempt, scheduledFor: '2026-10-19T09:00:00.000Z', state: 'sent' }]);
    assert.deepEqual(await repositories.attempts.listForCandidate('candidate-b'), [{ ...attempt, scheduledFor: '2026-10-19T09:00:00.000Z', state: 'sent' }]);
    await assert.rejects(
      repositories.attempts.record({ ...attempt, scheduledFor: 'not-a-date' }),
      /attempt.scheduledFor must be a valid date/,
    );

    const profileDocument = await db.collection<Document & { _id: string }>('applicant_profiles').findOne({ _id: 'synthetic-profile' });
    const candidateDocument = await db.collection<Document & { _id: string }>('professor_candidates').findOne({ _id: 'candidate-b' });
    assert.ok(profileDocument?.profile);
    assert.equal(candidateDocument?.profile, undefined);
    assert.equal(candidateDocument?.candidate && 'applicant' in candidateDocument.candidate, false);
    const attemptDocument = await db.collection<Document & { _id: string }>('outreach_attempts').findOne({
      _id: 'candidate-b:2026-10-19T09:00:00.000Z',
    });
    assert.equal(attemptDocument?.profile, undefined);
    assert.equal(attemptDocument?.candidate, undefined);
    const candidateIndexes = await db.collection('professor_candidates').listIndexes().toArray();
    const attemptIndexes = await db.collection('outreach_attempts').listIndexes().toArray();
    assert.ok(candidateIndexes.some((index) => index.name === 'unique_normalized_candidate_email'));
    assert.ok(attemptIndexes.some((index) => index.name === 'attempts_by_scheduled_time'));
    assert.ok(attemptIndexes.some((index) => index.name === 'attempts_by_candidate'));

    assert.equal(await repositories.profiles.delete('synthetic-profile'), true);
    assert.equal(await repositories.profiles.get('synthetic-profile'), undefined);
  } finally {
    if (db) await db.dropDatabase();
    await client.close();
  }
});
