import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import type { DiscoveryRun } from '../src/application/automatic-discovery.ts';
import { discoveryPilotSummary, runDiscoveryPilot, runRequestedDiscoveryPilot, runSouthKoreaProfessorPilot, type DiscoveryRunnerStage } from '../src/interfaces/discover-professor-candidates.ts';
import { runReadOnlyDiscoveryPreflight } from '../src/interfaces/discovery-preflight.ts';

const profile = parseApplicantProfile({
  applicant: {
    fullName: '', email: '', phone: '', nationality: '', currentLocation: '',
    degree: { title: '', institution: '', country: '', graduationYear: null, classification: '', gpa: null, gpaScale: null, gradingScaleDocument: '' },
    target: { degreeLevel: 'masters', intake: '2027', fields: ['Computer Science'], researchInterests: ['Distributed Systems'], countries: ['Canada', 'South Korea', 'Australia'], fundingTypes: ['scholarship'], timezone: 'Africa/Lagos' },
    englishEvidence: { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' },
    documents: { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] },
  },
});

function discoveryRunStore(records: DiscoveryRun[] = []) {
  return {
    async claim(run: DiscoveryRun) { records.push(run); return true; },
    async finish(run: DiscoveryRun) {
      const index = records.findIndex((item) => item.id === run.id);
      if (index < 0) throw new Error('run_not_claimed');
      records[index] = run;
    },
  };
}

test('regional pilot uses only the selected allowlisted country and configured profile scope', async () => {
  const calls: string[] = [];
  const result = await runDiscoveryPilot('Australia', {
    connect: async () => ({
      repositories: { profiles: { async get() { return undefined; } }, discoveryRuns: discoveryRunStore(), candidates: {
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

test('pilot stores bounded safe rejection diagnostics and includes them in its summary', async () => {
  const records: DiscoveryRun[] = [];
  const privateProfile = structuredClone(profile);
  privateProfile.applicant.target.fields = ['private-interest-canary'];
  privateProfile.applicant.fullName = 'private-profile-canary';
  const pages = new Map([
    ['https://uwaterloo.ca/faculty/no-identity', '<h1>Faculty directory</h1><a href="/profiles/no-person">View profile</a>'],
    ['https://uwaterloo.ca/profiles/no-person', '<h1>Faculty profile</h1><p>A university profile page.</p>'],
    ['https://uwaterloo.ca/faculty/with-research', '<h1>Faculty directory</h1><a href="/people/ada">View profile</a>'],
    ['https://uwaterloo.ca/people/ada', '<h1>Dr Ada Lovelace</h1><p>Associate Professor.</p><a href="/research/ada">Research group</a>'],
    ['https://uwaterloo.ca/research/ada', '<h1>Research group</h1><p>Computer science includes distributed systems and networks.</p>'],
  ]);
  const result = await runDiscoveryPilot('Canada', {
    connect: async () => ({
      repositories: {
        profiles: { async get() { return undefined; } },
        candidates: {
          async list(): Promise<ProfessorCandidate[]> { return []; },
          async save(): Promise<void> { assert.fail('rejected result must not be saved'); },
        },
        discoveryRuns: discoveryRunStore(records),
      },
      async close() {},
    }),
    loadProfile: async () => privateProfile,
    provider: { async search(query, options) {
      assert.equal(query.includes('private-interest-canary'), true);
      assert.equal(options?.count, 3);
      return [
        { resultNumber: 1, title: 'private-title-canary', url: 'https://cs.uwaterloo.ca/faculty?private-url-canary=private-credential-canary', excerpt: 'private-snippet-canary' },
        { resultNumber: 2, title: 'private-title-canary', url: 'https://uwaterloo.ca/faculty/no-identity', excerpt: 'private-snippet-canary' },
        { resultNumber: 3, title: 'private-title-canary', url: 'https://uwaterloo.ca/faculty/with-research', excerpt: 'private-snippet-canary' },
      ];
    } },
    fetchPage: async (url) => ({ url, html: pages.get(url) ?? '' }),
    recordDiagnostic: async () => {},
  });

  const expected = [
    { resultNumber: 1, stage: 'result_validation', reason: 'exact_host', observedHostname: 'cs.uwaterloo.ca' },
    { resultNumber: 2, stage: 'professor_evidence', reason: 'no_named_professor_identity', directoryPageFetched: true, sameHostProfileLinksFound: 1, sameHostProfileLinksConsidered: 1, sameHostProfileLinksFetched: 1, selectedProfileLinks: [{ rank: 1, reasons: ['profile_url_pattern', 'faculty_card_context', 'profile_label'] }], professorIdentityEstablished: false, linkedResearchPagesConsidered: 0, linkedResearchPagesFound: 0, linkedResearchPagesFetched: 0, relevantOfficialResearchEvidenceEstablished: false },
    { resultNumber: 3, stage: 'professor_evidence', reason: 'no_official_research_evidence', directoryPageFetched: true, sameHostProfileLinksFound: 1, sameHostProfileLinksConsidered: 1, sameHostProfileLinksFetched: 1, selectedProfileLinks: [{ rank: 1, reasons: ['profile_url_pattern', 'faculty_card_context', 'profile_label'] }], professorIdentityEstablished: true, linkedResearchPagesConsidered: 1, linkedResearchPagesFound: 1, linkedResearchPagesSelected: [{ rank: 1, reasons: ['research_anchor_text', 'research_url_pattern'] }], linkedResearchPagesFetched: 1, relevantOfficialResearchEvidenceEstablished: false },
  ];
  assert.deepEqual(result.resultDiagnostics, expected);
  assert.equal(records.length, 1);
  assert.deepEqual(records.at(-1)?.resultDiagnostics, expected);
  assert.deepEqual(discoveryPilotSummary('Canada', result).resultDiagnostics, expected);
  const storedAndDisplayed = JSON.stringify({ run: records.at(-1), summary: discoveryPilotSummary('Canada', result) });
  for (const privateValue of ['private-interest-canary', 'private-profile-canary', 'private-title-canary', 'private-snippet-canary', 'private-url-canary', 'private-credential-canary', 'Ada Lovelace', '/faculty/no-identity', '/people/ada', '/research/ada', 'https://']) {
    assert.equal(storedAndDisplayed.includes(privateValue), false);
  }
});

test('Estonia pilot falls back to query-and-host targeting for its unverified Brave code', async () => {
  const estoniaProfile = structuredClone(profile);
  estoniaProfile.applicant.target.countries.push('Estonia');
  const diagnostics: Array<{ outcome: string; targetingMode: string | undefined }> = [];
  const result = await runDiscoveryPilot('Estonia', {
    connect: async () => ({
      repositories: { profiles: { async get() { return undefined; } }, discoveryRuns: discoveryRunStore(), candidates: {
        async list(): Promise<ProfessorCandidate[]> { return []; },
        async save(): Promise<void> { assert.fail('empty search results must not be saved'); },
      } },
      async close() {},
    }),
    loadProfile: async () => estoniaProfile,
    provider: { async search(query, options) {
      assert.match(query, /site:taltech\.ee/);
      assert.match(query, /Estonia/);
      assert.equal(options?.region, 'Estonia');
      assert.equal(options?.countryCode, undefined);
      assert.equal(options?.targetingMode, 'query_and_host');
      assert.equal(options?.count, 3);
      return [];
    } },
    recordDiagnostic: async ({ outcome, targetingMode }) => { diagnostics.push({ outcome, targetingMode }); },
  });
  assert.equal(result.searches, 1);
  assert.equal(result.targetingMode, 'query_and_host');
  assert.deepEqual(diagnostics, [{ outcome: 'search_started', targetingMode: 'query_and_host' }]);
});

test('regional pilot refuses countries outside the private profile scope before reading or searching', async () => {
  let reads = 0;
  let searches = 0;
  await assert.rejects(runDiscoveryPilot('Switzerland', {
    connect: async () => ({
      repositories: { profiles: { async get() { return undefined; } }, discoveryRuns: discoveryRunStore(), candidates: {
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
      return { repositories: { profiles: { async get() { return undefined; } }, discoveryRuns: discoveryRunStore(), candidates }, async close() { calls.push('close'); } };
    },
    loadProfile: async () => profile,
    provider: { async search(query, options) {
      calls.push('brave-search');
      assert.match(query, /site:cs\.kaist\.ac\.kr/);
      assert.equal(options?.countryCode, undefined);
      assert.equal(options?.targetingMode, 'query_and_host');
      assert.equal(options?.count, 3);
      return [];
    } },
    recordDiagnostic: async () => {},
    onStage: (stage) => stages.push(stage),
  });

  assert.deepEqual(calls, ['shared-connect', 'candidate-list', 'brave-search', 'close']);
  assert.deepEqual(stages.slice(0, 5), ['mongodb_connect', 'profile_load', 'candidate_read', 'local_diagnostic_write', 'brave_search']);
  assert.equal(result.searches, 1);
  assert.equal(result.saved, 0);
  assert.equal(saved, 0);
});

test('discovery command forwards the requested country to its runner', async () => {
  const requested: string[] = [];
  await runRequestedDiscoveryPilot(['--region', 'Denmark'], async (region) => {
    requested.push(region);
    return undefined;
  });
  assert.deepEqual(requested, ['Denmark']);
});

test('read-only discovery preflight confirms saved preferences, countries, and lead IDs without exposing either', async () => {
  let closed = false;
  const preflightProfile = structuredClone(profile);
  const result = await runReadOnlyDiscoveryPreflight(async () => ({
    repositories: {
      profiles: { async get() { return preflightProfile; } },
      candidates: { async list() { return [{ id: 'private-lead-id' } as ProfessorCandidate]; }, async save() { assert.fail('preflight must not write'); } },
    },
    async close() { closed = true; },
  }));
  assert.deepEqual(result, {
    ok: true, profilePreferencesRead: true, profileCountriesConfigured: true, leadIdsRead: true, leadCount: 1,
  });
  assert.equal(JSON.stringify(result).includes('private-lead-id'), false);
  assert.equal(closed, true);
});
