import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { runDiscoveryPilot, runSouthKoreaProfessorPilot, type DiscoveryRunnerStage } from '../src/interfaces/discover-professor-candidates.ts';

const profile = parseApplicantProfile({
  applicant: {
    fullName: '', email: '', phone: '', nationality: '', currentLocation: '',
    degree: { title: '', institution: '', country: '', graduationYear: null, classification: '', gpa: null, gpaScale: null, gradingScaleDocument: '' },
    target: { degreeLevel: 'masters', intake: '2027', fields: ['Computer Science'], researchInterests: ['Distributed Systems'], countries: ['Canada', 'South Korea', 'Australia'], fundingTypes: ['scholarship'], timezone: 'Africa/Lagos' },
    englishEvidence: { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' },
    documents: { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] },
  },
});

test('regional pilot uses only the selected allowlisted country and configured profile scope', async () => {
  const calls: string[] = [];
  const result = await runDiscoveryPilot('Australia', {
    connect: async () => ({
      repositories: { candidates: {
        async list(): Promise<ProfessorCandidate[]> { calls.push('candidate-read'); return []; },
        async save(): Promise<void> { assert.fail('empty search results must not be saved'); },
      } },
      async close() {},
    }),
    loadProfile: async () => profile,
    provider: { async search(query, options) {
      calls.push('search');
      assert.match(query, /site:www\.sydney\.edu\.au/);
      assert.equal(options?.countryCode, 'AU');
      assert.equal(options?.count, 3);
      return [];
    } },
    recordDiagnostic: async () => {},
  });
  assert.deepEqual(calls, ['candidate-read', 'search']);
  assert.equal(result.searches, 1);
  assert.equal(result.saved, 0);
});

test('regional pilot refuses countries outside the private profile scope before reading or searching', async () => {
  let reads = 0;
  let searches = 0;
  await assert.rejects(runDiscoveryPilot('Switzerland', {
    connect: async () => ({
      repositories: { candidates: {
        async list(): Promise<ProfessorCandidate[]> { reads += 1; return []; },
        async save(): Promise<void> {},
      } },
      async close() {},
    }),
    loadProfile: async () => profile,
    provider: { async search() { searches += 1; return []; } },
  }), /Request parameters are invalid/);
  assert.equal(reads, 0);
  assert.equal(searches, 0);
});

test('South Korea pilot uses the injected shared storage, reads candidates before one capped search, and closes storage', async () => {
  const calls: string[] = [];
  const stages: DiscoveryRunnerStage[] = [];
  let saved = 0;
  const candidates = {
    async list(): Promise<ProfessorCandidate[]> { calls.push('candidate-list'); return []; },
    async save(): Promise<void> { saved += 1; },
  };
  const result = await runSouthKoreaProfessorPilot({
    connect: async () => {
      calls.push('shared-connect');
      return { repositories: { candidates }, async close() { calls.push('close'); } };
    },
    loadProfile: async () => profile,
    provider: { async search(query, options) {
      calls.push('brave-search');
      assert.match(query, /site:cs\.kaist\.ac\.kr/);
      assert.equal(options?.countryCode, 'KR');
      assert.equal(options?.count, 3);
      return [];
    } },
    recordDiagnostic: async () => {},
    onStage: (stage) => stages.push(stage),
  });

  assert.deepEqual(calls, ['shared-connect', 'candidate-list', 'brave-search', 'close']);
  assert.deepEqual(stages.slice(0, 4), ['mongodb_connect', 'profile_load', 'candidate_read', 'brave_search']);
  assert.equal(result.searches, 1);
  assert.equal(result.saved, 0);
  assert.equal(saved, 0);
});
