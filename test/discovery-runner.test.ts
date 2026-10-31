import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { runSouthKoreaProfessorPilot, type DiscoveryRunnerStage } from '../src/interfaces/discover-professor-candidates.ts';

const profile = parseApplicantProfile({
  applicant: {
    fullName: '', email: '', phone: '', nationality: '', currentLocation: '',
    degree: { title: '', institution: '', country: '', graduationYear: null, classification: '', gpa: null, gpaScale: null, gradingScaleDocument: '' },
    target: { degreeLevel: 'masters', intake: '2027', fields: ['Computer Science'], researchInterests: ['Distributed Systems'], countries: ['Canada'], fundingTypes: ['scholarship'], timezone: 'Africa/Lagos' },
    englishEvidence: { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' },
    documents: { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] },
  },
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
