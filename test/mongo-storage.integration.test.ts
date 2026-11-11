import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import '../src/infrastructure/local-env.ts';
import { MongoClient } from 'mongodb';
import type { Document } from 'mongodb';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import { createPhase2Indexes, createPhase4Indexes, createRepositories } from '../src/infrastructure/mongo-storage.ts';
import { migrateDiscoveryCollections } from '../src/infrastructure/discovery-collection-migration.ts';
import { safeFailureRecord } from '../src/infrastructure/sanitized-failure.ts';
import type { OutreachAttempt, ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import type { ProgramAssessment, ProgramRecord } from '../src/domain/program-assessment.ts';
import { assertMongoTestUri, getEnabledMongoTestUri } from './mongo-test-uri.ts';

const mongoUri = getEnabledMongoTestUri({ enabled: process.env.RUN_MONGODB_INTEGRATION, uri: process.env.MONGODB_TEST_URI });
const examplePath = new URL('../private.profile.example.json', import.meta.url);
const testCollections = [
  'applicant_profiles', 'professor_candidates', 'candidate_evidence_triage', 'discovery_leads', 'lead_triage_recommendations', 'programs', 'program_assessments', 'outreach_control', 'outreach_attempts',
  'discovery_job_runs',
  'saved_lead_reprocess_runs', 'confirmed_professors',
];

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
  assertMongoTestUri(mongoUri!);

  const client = new MongoClient(mongoUri!);
  let stage = 'client_connect';
  let db;
  try {
    await client.connect();
    db = client.db('gradreach_test');
    stage = 'discovery_migration';
    await migrateDiscoveryCollections(db);
    stage = 'index_creation';
    await createPhase2Indexes(db);
    await createPhase4Indexes(db);
    const repositories = createRepositories(db);
    const profile = parseApplicantProfile(JSON.parse(await readFile(examplePath, 'utf8')) as unknown);

    stage = 'profile_storage';
    await repositories.profiles.save('synthetic-profile', profile);
    assert.deepEqual(await repositories.profiles.get('synthetic-profile'), profile);

    stage = 'candidate_storage';
    await repositories.candidates.save(sampleCandidate('candidate-a', 'a@example.edu'));
    await repositories.candidates.save(sampleCandidate('candidate-b', 'b@example.edu'));
    assert.deepEqual((await repositories.candidates.list()).map((candidate) => candidate.id), ['candidate-a', 'candidate-b']);
    assert.deepEqual(await repositories.candidates.get('candidate-a'), sampleCandidate('candidate-a', 'a@example.edu'));
    await assert.rejects(
      repositories.candidates.save(sampleCandidate('candidate-c', ' A@EXAMPLE.edu ')),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 11000,
    );
    assert.equal(await repositories.candidates.delete('candidate-a'), true);

    stage = 'program_and_assessment_storage';
    await repositories.programs.save(sampleProgram);
    assert.deepEqual(await repositories.programs.get(sampleProgram.id), sampleProgram);
    assert.deepEqual(await repositories.programs.list(), [sampleProgram]);
    await repositories.assessments.save(sampleAssessment('2026-10-19T10:00:00+01:00'));
    await repositories.assessments.save(sampleAssessment('2026-10-20T10:00:00Z'));
    assert.deepEqual(await repositories.assessments.latest(sampleProgram.id), sampleAssessment('2026-10-20T10:00:00.000Z'));

    stage = 'scheduler_storage';
    const schedulerControl = { paused: true, timeZone: 'Africa/Lagos', dailyLimit: 5 };
    await repositories.schedulerControl.save(schedulerControl);
    assert.deepEqual(await repositories.schedulerControl.get(), schedulerControl);
    await assert.rejects(repositories.schedulerControl.save({ ...schedulerControl, dailyLimit: 6 }), /dailyLimit must be an integer from 1 to 5/);
    assert.equal(await repositories.schedulerControl.reserveDailySend('2026-10-19T10:00:00Z'), false);
    await repositories.schedulerControl.save({ ...schedulerControl, paused: false });
    for (let index = 0; index < 5; index += 1) assert.equal(await repositories.schedulerControl.reserveDailySend(`2026-10-19T10:0${index}:00Z`), true);
    assert.equal(await repositories.schedulerControl.reserveDailySend('2026-10-19T10:05:00Z'), false);
    assert.equal(await repositories.schedulerControl.reserveDailySend('2026-10-20T00:00:00Z'), true);

    stage = 'discovery_run_diagnostic_storage';
    const discoveryRun = {
      id: 'synthetic-diagnostic-run', scheduledFor: '2026-10-20T09:00:00.000Z', startedAt: '2026-10-20T09:00:00.000Z',
      country: 'Synthetic country', state: 'completed' as const,
      counts: { searches: 1, results: 1, saved: 0, duplicates: 0, rejections: 1, fetchFailures: 0, inspected: 0, inspectionFailures: 0 },
      resultDiagnostics: [{ resultNumber: 1, stage: 'professor_evidence' as const, reason: 'no_named_professor_identity' }],
    };
    assert.equal(await repositories.discoveryRuns.claim({ ...discoveryRun, state: 'running' }), true);
    await repositories.discoveryRuns.finish(discoveryRun);
    assert.deepEqual((await repositories.discoveryRuns.list(10)).find((item) => item.id === discoveryRun.id), discoveryRun);
    const storedRun = await db.collection<Document & { _id: string }>('discovery_job_runs').findOne({ _id: discoveryRun.id });
    const serializedRun = JSON.stringify(storedRun?.run);
    assert.equal(serializedRun.includes('query-canary'), false);
    assert.equal(serializedRun.includes('profile-canary'), false);

    stage = 'discovery_incremental_restart_storage';
    const interruptedRun = {
      ...discoveryRun, id: 'synthetic-interrupted-run', scheduledFor: '2026-10-21T09:00:00.000Z', slotId: 'synthetic-slot',
      trigger: 'scheduled' as const, runKind: 'country' as const, workerId: 'synthetic-worker', taskName: 'Synthetic Task',
      country: 'Synthetic country', state: 'running' as const, resultDiagnostics: [],
    };
    assert.equal(await repositories.discoveryRuns.claim(interruptedRun), true);
    const durableDiagnostic = { resultNumber: 1, stage: 'professor_evidence' as const, reason: 'no_official_research_evidence', identityConfirmed: true, researchEvidenceFound: false, interestMatched: null, sameHostProfileLinksFetched: 2, savedRecords: [{ kind: 'confirmed_professor' as const, id: 'synthetic-professor' }] };
    await repositories.discoveryRuns.recordDiagnostic(interruptedRun.id, durableDiagnostic);
    await repositories.discoveryRuns.recordDiagnostic(interruptedRun.id, durableDiagnostic);
    await repositories.discoveryRuns.recordDiagnostic(interruptedRun.id, { ...durableDiagnostic, reason: 'token-canary' } as never);
    await repositories.discoveryRuns.recordProgress(interruptedRun.id, { ...interruptedRun.counts, searches: 1, results: 2, pageFetches: 3 });
    const countryOutcome = { country: 'Synthetic country', runId: interruptedRun.id, state: 'completed' as const, counts: interruptedRun.counts };
    const { country: _country, ...batchBase } = interruptedRun;
    const syntheticBatch = { ...batchBase, id: 'synthetic-incremental-batch', scheduledFor: '2026-10-23T09:00:00.000Z', countries: ['Synthetic country'], runKind: 'batch' as const, countryOutcomes: [], state: 'running' as const };
    assert.equal(await repositories.discoveryRuns.claim(syntheticBatch), true);
    await repositories.discoveryRuns.recordCountryOutcome(syntheticBatch.id, { ...countryOutcome, state: 'failed' });
    await repositories.discoveryRuns.recordCountryOutcome(syntheticBatch.id, { ...countryOutcome, state: 'failed' });
    const durableBatch = await repositories.discoveryRuns.list(10);
    const batchRecord = durableBatch.find((item) => item.id === syntheticBatch.id);
    assert.equal(batchRecord?.countryOutcomes?.length, 1);
    assert.deepEqual(await repositories.discoveryRuns.recoverInterrupted('2026-10-22T00:00:00.000Z', '2026-10-22T00:00:01.000Z'), 1);
    const recovered = (await repositories.discoveryRuns.list(10)).find((item) => item.id === interruptedRun.id)!;
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.failureCode, 'worker_interrupted');
    assert.deepEqual(recovered.resultDiagnostics, [durableDiagnostic]);
    assert.equal(recovered.counts.searches, 1);
    assert.equal(recovered.counts.results, 2);
    assert.equal(JSON.stringify(recovered).includes('query-canary'), false);
    assert.equal(JSON.stringify(recovered).includes('token-canary'), false);

    stage = 'saved_lead_reprocessing_run_storage';
    const reprocessRun = {
      id: 'synthetic-reprocess-run', state: 'running' as const, startedAt: '2026-10-20T10:00:00.000Z',
      counts: { inspected: 0, enriched: 0, unchanged: 0, failed: 0, pageFetches: 0 }, reasonCounts: {},
      omittedByLeadLimit: 0, duplicateIdentifiersSkipped: 0,
      results: [],
    };
    await repositories.savedLeadReprocessRuns.start(reprocessRun);
    const reprocessResult = {
      candidateId: 'candidate-b', outcome: 'enriched' as const, reasonCode: 'evidence_added' as const,
      diagnostics: {
        stageOutcome: 'enriched' as const,
        traversal: {
          directoryFetched: true, profileLinksConsidered: 3, profileLinksSelected: 1, profileLinksFetched: 1,
          identityEstablished: true, researchLinksConsidered: 4, researchLinksEligible: 2,
          researchLinksSelected: 2, researchLinksFetched: 1, relevantResearchEstablished: true,
        },
      },
    };
    assert.equal(await repositories.savedLeadReprocessRuns.recordResult(reprocessRun.id, reprocessResult), true);
    assert.equal(await repositories.savedLeadReprocessRuns.recordResult(reprocessRun.id, reprocessResult), true);
    const completedReprocessRun = {
      ...reprocessRun, state: 'completed' as const, finishedAt: '2026-10-20T10:01:00.000Z',
      counts: { inspected: 1, enriched: 1, unchanged: 0, failed: 0, pageFetches: 2 },
      reasonCounts: { evidence_added: 1 }, results: [reprocessResult],
    };
    await repositories.savedLeadReprocessRuns.finish(completedReprocessRun);
    assert.deepEqual(await repositories.savedLeadReprocessRuns.get(reprocessRun.id), completedReprocessRun);
    assert.deepEqual((await repositories.savedLeadReprocessRuns.list()).map((item) => item.id), [reprocessRun.id]);
    const storedReprocessRun = await db.collection<Document & { _id: string }>('saved_lead_reprocess_runs').findOne({ _id: reprocessRun.id });
    const serializedReprocessRun = JSON.stringify(storedReprocessRun?.run);
    assert.equal(serializedReprocessRun.includes('private query'), false);
    assert.equal(serializedReprocessRun.includes('https://'), false);
    assert.deepEqual((await repositories.savedLeadReprocessRuns.get(reprocessRun.id))?.results[0]?.diagnostics, reprocessResult.diagnostics);

    stage = 'confirmed_professor_storage';
    const confirmed = {
      stableId: 'discovery-synthetic-confirmed', name: 'Synthetic Professor', institution: 'Example University', country: 'Canada',
      officialProfileUrl: 'https://uwaterloo.ca/electrical-computer-engineering/profile/synthetic', researchEvidence: [],
      researchStatus: 'matched' as const, researchStatusExplanation: 'Synthetic test evidence.', duplicate: false, sourceReports: ['synthetic-preview.json'],
      localOwnerDecision: 'accepted_local_only' as const, approved: false as const, queued: false as const, sent: false as const,
      researchOutcome: 'matched' as const,
    };
    assert.equal(await repositories.confirmedProfessors.upsert(confirmed), 'inserted');
    assert.equal(await repositories.confirmedProfessors.upsert(confirmed), 'updated');
    await db.collection<Document & { _id: string }>('confirmed_professors').updateOne({ _id: confirmed.stableId }, { $set: { ownerDecision: 'rejected', approved: true, queued: true, sent: true } });
    assert.equal(await repositories.confirmedProfessors.upsert(confirmed), 'updated');
    const confirmedDocument = await db.collection<Document & { _id: string }>('confirmed_professors').findOne({ _id: confirmed.stableId });
    assert.equal(confirmedDocument?.ownerDecision, 'rejected');
    assert.equal(confirmedDocument?.approved, true);
    assert.equal(confirmedDocument?.queued, true);
    assert.equal(confirmedDocument?.sent, true);
    assert.equal(confirmedDocument?.researchOutcome, 'matched');

    assert.equal(await repositories.candidates.appendValidatedResearchEvidence({
      candidateId: 'candidate-b', officialProfileUrl: 'https://example.edu/faculty/synthetic',
      professorName: 'Synthetic Professor', leadName: 'Synthetic Professor', runId: reprocessRun.id,
      evidence: [{ kind: 'research', sourceUrl: 'https://example.edu/research/synthetic', excerpt: 'Synthetic evidence.', quote: 'Synthetic research quote.', retrievedAt: '2026-10-20T10:00:00.000Z', verification: 'unverified', region: 'Example', query: 'synthetic query' }],
    }), true);
    const markedCandidate = await db.collection<Document & { _id: string }>('discovery_leads').findOne({ _id: 'candidate-b' }, { projection: { lastReprocessedRunId: 1, 'candidate.status': 1, 'candidate.approvedForSending': 1, 'candidate.id': 1 } });
    assert.equal(markedCandidate?.lastReprocessedRunId, reprocessRun.id);
    assert.equal((markedCandidate?.candidate as Record<string, unknown> | undefined)?.status, 'researching');
    assert.equal((markedCandidate?.candidate as Record<string, unknown> | undefined)?.approvedForSending, false);
    assert.equal((markedCandidate?.candidate as Record<string, unknown> | undefined)?.id, 'candidate-b');

    stage = 'attempt_storage';
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

    stage = 'privacy_and_index_assertions';
    const profileDocument = await db.collection<Document & { _id: string }>('applicant_profiles').findOne({ _id: 'synthetic-profile' });
    const candidateDocument = await db.collection<Document & { _id: string }>('discovery_leads').findOne({ _id: 'candidate-b' });
    assert.ok(profileDocument?.profile);
    assert.equal(candidateDocument?.profile, undefined);
    assert.equal(candidateDocument?.candidate && 'applicant' in candidateDocument.candidate, false);
    const attemptDocument = await db.collection<Document & { _id: string }>('outreach_attempts').findOne({
      _id: 'candidate-b:2026-10-19T09:00:00.000Z',
    });
    assert.equal(attemptDocument?.profile, undefined);
    assert.equal(attemptDocument?.candidate, undefined);
    assert.equal((attemptDocument?.attempt as OutreachAttempt | undefined)?.providerMessageId, 'mock-message-id');
    const candidateIndexes = await db.collection('discovery_leads').listIndexes().toArray();
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
  } catch (error) {
    const failure = safeFailureRecord(error);
    throw new Error(JSON.stringify({
      stage,
      kind: failure.kind,
      ...(failure.errorName ? { errorName: failure.errorName } : {}),
      ...(failure.codeName ? { codeName: failure.codeName } : {}),
      ...(failure.errorCode ? { code: failure.errorCode } : {}),
      ...(failure.causeName ? { causeName: failure.causeName } : {}),
      ...(failure.causeCode ? { causeCode: failure.causeCode } : {}),
      ...(failure.syscall ? { syscall: failure.syscall } : {}),
      ...(failure.serverStates ? { serverStates: failure.serverStates } : {}),
    }));
  } finally {
    if (db) {
      for (const collectionName of testCollections) {
        try {
          await db.collection(collectionName).drop();
        } catch (error) {
          if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 26) throw error;
        }
      }
    }
    await client.close();
  }
});
