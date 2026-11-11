import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import type { SearchOptions, SearchResult } from '../src/infrastructure/brave-search-provider.ts';
import { runCanadaDiscoveryPreview, type DiscoveryPreviewReport } from '../src/interfaces/discover-professor-preview.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';
import { runDiscoveryPreview } from '../src/interfaces/discover-professor-preview.ts';

const profile = parseApplicantProfile({
  applicant: {
    fullName: '', email: '', phone: '', nationality: '', currentLocation: '',
    degree: { title: '', institution: '', country: '', graduationYear: null, classification: '', gpa: null, gpaScale: null, gradingScaleDocument: '' },
    target: { degreeLevel: 'masters', intake: '2027', fields: ['Computer Science'], researchInterests: ['distributed systems'], countries: ['Canada'], fundingTypes: ['scholarship'], timezone: 'Africa/Lagos' },
    englishEvidence: { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' },
    documents: { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] },
  },
});

const host = OFFICIAL_HOSTS_BY_REGION.Canada[0]!;
const singleRequestBudget = { maxSearchRequestsPerCountry: 1, resultsPerSearch: 3, maxPagesPerQuery: 1, minimumRequestIntervalMs: 0 };

function fixtureStorage(saved: ProfessorCandidate[] = []) {
  let mongoWrites = 0;
  let closed = false;
  return {
    get mongoWrites() { return mongoWrites; },
    get closed() { return closed; },
    async connect() {
      return {
        repositories: {
          profiles: { async get() { return profile; } },
          candidates: {
            async list() { return saved; },
            async save() { mongoWrites += 1; },
          },
        },
        async close() { closed = true; },
      };
    },
  };
}

function searchResults(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Faculty listing ${index + 1}`,
    url: `https://${host}/faculty/result-${index + 1}`,
    excerpt: 'Official faculty listing for academic staff.',
  }));
}

function directProfile(name: string, research: string): string {
  return `<h1>Dr ${name}</h1><p>Associate Professor.</p><p>Her research focuses on ${research} across reliable computing systems and applications.</p>`;
}

test('preview uses official evidence and saved interests without writing candidate or Mongo diagnostics', async () => {
  const storage = fixtureStorage();
  let providerCalls = 0;
  let searchOptions: SearchOptions | undefined;
  let report: DiscoveryPreviewReport | undefined;
  const results = searchResults(2);
  const pages = new Map([
    [results[0]!.url, '<h1>Faculty directory</h1><article class="faculty-card"><h3>Dr Ada Lovelace</h3><p>Professor of Computer Science</p><a href="/people/ada">View profile</a></article>'],
    [`https://${host}/people/ada`, '<h1>Dr Ada Lovelace</h1><p>Associate Professor.</p><a href="/research/ada">Research group</a>'],
    [`https://${host}/research/ada`, '<h1>Research group</h1><p>Her research focuses on distributed systems and reliable computing in large network applications, contact ada@example.edu.</p>'],
    [results[1]!.url, '<h1>Faculty directory</h1><article class="faculty-card"><h3>Dr Ben Example</h3><p>Professor of Computer Science</p><a href="/people/ben">View profile</a></article>'],
    [`https://${host}/people/ben`, '<h1>Dr Ben Example</h1><p>Associate Professor.</p><a href="/research/ben">Research group</a>'],
    [`https://${host}/research/ben`, '<h1>Research group</h1><p>His research focuses on marine biology and coastal ecosystem conservation.</p>'],
  ]);
  const output = await runCanadaDiscoveryPreview({
    connect: storage.connect,
    budget: singleRequestBudget,
    provider: {
      async search(_query, options) { providerCalls += 1; searchOptions = options; return results; },
    },
    async fetchPage(url) { return { url, html: pages.get(url) ?? '' }; },
    async writeReport(value) { report = value; return 'private-data/discovery-previews/test-report.json'; },
    now: () => new Date('2026-11-10T10:00:00.000Z'),
  });

  assert.equal(providerCalls, 1);
  assert.equal(searchOptions?.count, 3);
  assert.equal(searchOptions?.region, 'Canada');
  assert.deepEqual(output.summary, {
    region: 'Canada', searches: 1, results: 2, pageFetches: 6, passed: 1, duplicates: 0,
    searchCoverage: 'incomplete', coverageStopReasons: ['search_request_budget_exhausted'], stopped: 1,
    reasonCounts: { passed_all_gates: 1, research_interest_mismatch: 1 },
  });
  assert.equal(report?.candidates[0]?.name, 'Ada Lovelace');
  assert.equal(report?.candidates[0]?.institution, 'University of Waterloo');
  assert.equal(report?.candidates[0]?.officialProfileSource, `https://${host}/people/ada`);
  assert.deepEqual(report?.candidates[0]?.researchSources, [{
    url: `https://${host}/research/ada`,
    supportingEvidence: 'Her research focuses on distributed systems and reliable computing in large network applications, contact [email omitted].',
  }]);
  assert.equal(report?.candidates[0]?.reason, 'passed_all_gates');
  assert.equal(report?.candidates[0]?.interestMatch, 'matched');
  assert.equal(report?.candidates[0]?.reviewStatus, 'awaiting_owner_review');
  assert.equal(report?.candidates[0]?.approved, false);
  assert.equal(report?.candidates[0]?.queued, false);
  assert.equal(report?.candidates[0]?.sent, false);
  assert.match(report?.candidates[0]?.matchExplanation ?? '', /matched the saved profile interests/);
  assert.equal(report?.candidates[1]?.reason, 'research_interest_mismatch');
  assert.equal(report?.candidates[1]?.interestMatch, 'not_matched');
  assert.match(report?.candidates[1]?.matchExplanation ?? '', /did not match/);
  assert.equal(JSON.stringify(report).includes('ada@example.edu'), false);
  assert.equal(JSON.stringify(report).includes('[email omitted]'), true);
  assert.equal(JSON.stringify(report).includes('search-result'), false);
  assert.equal(JSON.stringify(report).includes('query'), false);
  assert.equal(storage.mongoWrites, 0);
  assert.equal(storage.closed, true);
});

test('preview exposes pagination budgets and marks early search-budget stops incomplete', async () => {
  const storage = fixtureStorage();
  const offsets: number[] = [];
  let report: DiscoveryPreviewReport | undefined;
  const output = await runCanadaDiscoveryPreview({
    connect: storage.connect,
    budget: { maxSearchRequestsPerCountry: 6, resultsPerSearch: 20, maxPagesPerQuery: 2, minimumRequestIntervalMs: 0 },
    provider: {
      async search() { assert.fail('pagination-aware provider method should be used'); },
      async searchPage(_query, options) {
        offsets.push(options?.offset ?? -1);
        return { results: [], moreResultsAvailable: options?.offset === 0, paginationKnown: true };
      },
    },
    async writeReport(value) { report = value; return 'private-data/discovery-previews/budget-test.json'; },
  });
  assert.equal(output.summary.searches, 6);
  assert.deepEqual(offsets, [0, 1, 0, 1, 0, 1]);
  assert.equal(report?.searchCoverage, 'incomplete');
  assert.deepEqual(report?.coverageStopReasons, ['search_request_budget_exhausted']);
  assert.equal(report?.budget.resultsPerSearch, 20);
  assert.equal(storage.mongoWrites, 0);
});

test('country preview applies the same one-request pipeline and country-specific official host', async () => {
  const belgiumProfile = parseApplicantProfile({ ...profile, applicant: { ...profile.applicant, target: { ...profile.applicant.target, countries: ['Belgium'] } } });
  const belgiumHost = OFFICIAL_HOSTS_BY_REGION.Belgium[0]!;
  let requests = 0;
  let mongoWrites = 0;
  let report: DiscoveryPreviewReport | undefined;
  const output = await runDiscoveryPreview('Belgium', {
    budget: singleRequestBudget,
    connect: async () => ({
      repositories: {
        profiles: { async get() { return belgiumProfile; } },
        candidates: { async list() { return []; }, async save() { mongoWrites += 1; } },
      },
      async close() {},
    }),
    provider: { async search(_query, options) { requests += 1; assert.equal(options?.count, 3); return []; } },
    async writeReport(value) { report = value; return 'private-data/discovery-previews/belgium-test.json'; },
  });
  assert.equal(requests, 1);
  assert.equal(output.summary.region, 'Belgium');
  assert.equal(report?.institution, 'KU Leuven');
  assert.equal(report?.searches, 1);
  assert.equal(report?.results, 0);
  assert.equal(mongoWrites, 0);
  assert.equal(belgiumHost, 'eng.kuleuven.be');
});

test('preview makes no Brave request when the read-only profile load fails', async () => {
  let providerCalls = 0;
  await assert.rejects(runCanadaDiscoveryPreview({
    connect: async () => ({
      repositories: {
        profiles: { async get() { throw new Error('private profile read failure'); } },
        candidates: { async list() { assert.fail('candidate reads wait until profile load succeeds'); } },
      },
      async close() {},
    }),
    provider: { async search() { providerCalls += 1; return []; } },
    async writeReport() { return 'unused'; },
  }));
  assert.equal(providerCalls, 0);
});

test('preview enforces one three-result request and its configured page-fetch cap', async () => {
  const storage = fixtureStorage();
  let providerCalls = 0;
  let requestedCount = 0;
  let fetches = 0;
  let report: DiscoveryPreviewReport | undefined;
  const results = searchResults(5);
  const output = await runCanadaDiscoveryPreview({
    connect: storage.connect,
    budget: singleRequestBudget,
    provider: {
      async search(_query, options) {
        providerCalls += 1;
        requestedCount = options?.count ?? 0;
        return results;
      },
    },
    async fetchPage(url) {
      fetches += 1;
      const number = Number(url.match(/result-(\d+)/)?.[1]);
      const names = ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson'];
      const name = names[number - 1] ?? 'Ada Lovelace';
      return { url, html: url.includes('/faculty/result-')
        ? `<h1>Faculty directory</h1><article class="faculty-card"><h3>Dr ${name}</h3><p>Professor of Computer Science</p><a href="/people/faculty-${number}">View profile</a></article>`
        : directProfile(name, 'distributed systems') };
    },
    maxPageFetchesPerRun: 4,
    async writeReport(value) { report = value; return 'private-data/discovery-previews/cap-test.json'; },
  });
  assert.equal(providerCalls, 1);
  assert.equal(requestedCount, 3);
  assert.equal(fetches, 4);
  assert.equal(output.summary.results, 3);
  assert.equal(output.summary.pageFetches, 4);
  assert.deepEqual(report?.candidates.map(({ reason }) => reason), ['passed_all_gates', 'passed_all_gates', 'page_fetch_limit']);
  assert.equal(storage.mongoWrites, 0);
});

test('preview detects saved-result duplicates without fetching pages', async () => {
  const duplicateUrl = `https://${host}/faculty/already-saved`;
  const saved: ProfessorCandidate = {
    id: 'existing-stable-id', name: 'Existing lead', institution: 'University of Waterloo', country: 'Canada',
    status: 'needs-evidence', approvedForSending: false, priority: 0,
    discoveryEvidence: [{ kind: 'search-result', sourceUrl: duplicateUrl, excerpt: 'Official faculty result.', retrievedAt: '2026-11-01T00:00:00.000Z', verification: 'unverified', region: 'Canada', query: 'saved private query' }],
  };
  const storage = fixtureStorage([saved]);
  let fetches = 0;
  let report: DiscoveryPreviewReport | undefined;
  await runCanadaDiscoveryPreview({
    connect: storage.connect,
    budget: singleRequestBudget,
    provider: { async search() { return [{ title: 'New listing', url: duplicateUrl, excerpt: 'Official faculty listing.' }]; } },
    async fetchPage(url) { fetches += 1; return { url, html: '' }; },
    async writeReport(value) { report = value; return 'private-data/discovery-previews/duplicate-test.json'; },
  });
  assert.equal(fetches, 0);
  assert.equal(report?.candidates[0]?.reason, 'duplicate_saved_lead');
  assert.equal(storage.mongoWrites, 0);
});

test('preview paginates focused searches, removes repeated result URLs, and keeps successful leads awaiting review', async () => {
  const storage = fixtureStorage();
  const result = searchResults(1)[0]!;
  let searches = 0;
  let pageFetches = 0;
  let delays = 0;
  let report: DiscoveryPreviewReport | undefined;
  const output = await runCanadaDiscoveryPreview({
    connect: storage.connect,
    budget: { maxSearchRequestsPerCountry: 4, resultsPerSearch: 20, maxPagesPerQuery: 1, minimumRequestIntervalMs: 25 },
    async sleep(milliseconds) { delays += 1; assert.ok(milliseconds >= 0); },
    provider: {
      async search() { assert.fail('searchPage must be used when available'); },
      async searchPage() { searches += 1; return { results: [result], moreResultsAvailable: false, paginationKnown: true }; },
    },
    async fetchPage(url) {
      pageFetches += 1;
      return { url, html: '<h1>Dr Ada Lovelace</h1><p>Associate Professor.</p><p>Her research focuses on distributed systems and reliable computing across large networks.</p>' };
    },
    async writeReport(value) { report = value; return 'private-data/discovery-previews/multipage-test.json'; },
  });
  assert.equal(searches, 4, JSON.stringify({ summary: output.summary, failureCode: report?.failureCode, coverage: report?.coverageStopReasons }));
  assert.equal(delays, 3);
  assert.equal(output.summary.searchCoverage, 'complete');
  assert.equal(output.summary.results, 4);
  assert.equal(output.summary.passed, 1);
  assert.equal(output.summary.duplicates, 3);
  assert.equal(pageFetches, 1);
  assert.deepEqual(report?.candidates.map((candidate) => candidate.reason), [
    'passed_all_gates', 'duplicate_saved_lead', 'duplicate_saved_lead', 'duplicate_saved_lead',
  ]);
  assert.ok(report?.candidates.every((candidate) => candidate.reviewStatus === 'awaiting_owner_review' && !candidate.approved && !candidate.queued && !candidate.sent));
  assert.equal(storage.mongoWrites, 0);
});
