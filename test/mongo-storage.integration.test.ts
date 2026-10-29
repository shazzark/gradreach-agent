import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import type { Document } from 'mongodb';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import { createPhase2Indexes, createPhase4Indexes, createRepositories } from '../src/infrastructure/mongo-storage.ts';
import type { OutreachAttempt, ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import type { ProgramAssessment, ProgramRecord } from '../src/domain/program-assessment.ts';

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

const sampleProgram: ProgramRecord = {
  id: 'synthetic-msc', institution: 'Example University', name: 'MSc Example', country: 'Example country', intake: '2027',
};

function sampleAssessment(assessedAt: string): ProgramAssessment {
  const finding = { outcome: 'unclear' as const, reasons: ['Synthetic fixture.'], evidence: [] };
  return { programId: sampleProgram.id, assessedAt, admissions: finding, english: finding, tuition: finding, funding: finding, intake: finding, deadline: finding, overall: 'unclear' };
}

test('Mongo profile, candidate, program, assessment and scheduler repositories preserve storage boundaries', {
  skip: !mongoUri ? 'Set MONGODB_TEST_URI to an isolated test deployment to run MongoDB integration checks' : false,
}, async () => {
  const client = new MongoClient(mongoUri!);
  const databaseName = `gradreach_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  let db;
  try {
    await client.connect();
    db = client.db(databaseName);
    await createPhase2Indexes(db);
    await createPhase4Indexes(db);
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

    await repositories.programs.save(sampleProgram);
    assert.deepEqual(await repositories.programs.get(sampleProgram.id), sampleProgram);
    assert.deepEqual(await repositories.programs.list(), [sampleProgram]);
    await repositories.assessments.save(sampleAssessment('2026-10-19T10:00:00+01:00'));
    await repositories.assessments.save(sampleAssessment('2026-10-20T10:00:00Z'));
    assert.deepEqual(await repositories.assessments.latest(sampleProgram.id), sampleAssessment('2026-10-20T10:00:00.000Z'));

    const schedulerControl = { paused: true, timeZone: 'Africa/Lagos', dailyLimit: 5 };
    await repositories.schedulerControl.save(schedulerControl);
    assert.deepEqual(await repositories.schedulerControl.get(), schedulerControl);
    await assert.rejects(repositories.schedulerControl.save({ ...schedulerControl, dailyLimit: 6 }), /dailyLimit must be an integer from 1 to 5/);
    assert.equal(await repositories.schedulerControl.reserveDailySend('2026-10-19T10:00:00Z'), false);
    await repositories.schedulerControl.save({ ...schedulerControl, paused: false });
    for (let index = 0; index < 5; index += 1) assert.equal(await repositories.schedulerControl.reserveDailySend(`2026-10-19T10:0${index}:00Z`), true);
    assert.equal(await repositories.schedulerControl.reserveDailySend('2026-10-19T10:05:00Z'), false);
    assert.equal(await repositories.schedulerControl.reserveDailySend('2026-10-20T00:00:00Z'), true);

    const attempt: OutreachAttempt = {
      candidateId: 'candidate-b',
      recipientEmail: 'b@example.edu',
      scheduledFor: '2026-10-19T10:00:00+01:00',
      state: 'queued',
    };
    await repositories.attempts.record(attempt);
    const canonicalAttempt = { ...attempt, scheduledFor: '2026-10-19T09:00:00.000Z' };
    assert.deepEqual(await repositories.attempts.listAll(), [canonicalAttempt]);
    const claimed = await repositories.attempts.claimForDelivery(canonicalAttempt, '2026-10-19T08:00:00Z', 3);
    assert.equal(claimed?.state, 'sending');
    assert.equal(claimed?.deliveryAttempts, 1);
    const sent = { ...claimed!, state: 'sent' as const, sentAt: '2026-10-19T08:00:01.000Z', providerMessageId: 'mock-message-id' };
    assert.equal(await repositories.attempts.updateDelivery(sent), true);
    assert.deepEqual(await repositories.attempts.listAll(), [sent]);
    assert.deepEqual(await repositories.attempts.listForCandidate('candidate-b'), [sent]);
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
    assert.equal((attemptDocument?.attempt as OutreachAttempt | undefined)?.providerMessageId, 'mock-message-id');
    const candidateIndexes = await db.collection('professor_candidates').listIndexes().toArray();
    const attemptIndexes = await db.collection('outreach_attempts').listIndexes().toArray();
    const assessmentIndexes = await db.collection('program_assessments').listIndexes().toArray();
    const programIndexes = await db.collection('programs').listIndexes().toArray();
    assert.ok(candidateIndexes.some((index) => index.name === 'unique_normalized_candidate_email'));
    assert.ok(attemptIndexes.some((index) => index.name === 'attempts_by_scheduled_time'));
    assert.ok(attemptIndexes.some((index) => index.name === 'attempts_by_candidate'));
    assert.ok(assessmentIndexes.some((index) => index.name === 'assessments_by_program_and_date'));
    assert.ok(programIndexes.some((index) => index.name === 'programs_by_country_institution'));

    assert.equal(await repositories.profiles.delete('synthetic-profile'), true);
    assert.equal(await repositories.profiles.get('synthetic-profile'), undefined);
    assert.equal(await repositories.programs.delete(sampleProgram.id), true);
  } finally {
    if (db) await db.dropDatabase();
    await client.close();
  }
});
