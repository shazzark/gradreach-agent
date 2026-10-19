import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { discoverProfessorCandidates } from '../src/application/research-discovery.ts';
import { BraveSearchProvider } from '../src/infrastructure/brave-search-provider.ts';

const profile = parseApplicantProfile({
  applicant: {
    fullName: '', email: '', phone: '', nationality: '', currentLocation: '',
    degree: { title: '', institution: '', country: '', graduationYear: null, classification: '', gpa: null, gpaScale: null, gradingScaleDocument: '' },
    target: { degreeLevel: 'masters', intake: '2027', fields: ['Computer Science'], researchInterests: ['Distributed Systems'], countries: ['Country A', 'Country B'], fundingTypes: ['scholarship', 'low-tuition'], timezone: 'Africa/Lagos' },
    englishEvidence: { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' },
    documents: { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] },
  },
});

test('discovery searches every configured region and persists official-host results as review-gated leads', async () => {
  const queried: string[] = [];
  const saved: ProfessorCandidate[] = [];
  const result = await discoverProfessorCandidates({
    profile,
    provider: {
      async search(query, options) {
        queried.push(`${query}|${options?.countryCode ?? ''}`);
        const host = query.includes('countrya.edu') ? 'countrya.edu' : 'countryb.ac.uk';
        const trackingVariant = query.includes('Distributed Systems') ? '?utm_source=second#section' : '?ref=first';
        return [
          { title: `Synthetic page at ${host}`, url: `https://www.${host}/people/professor${trackingVariant}`, excerpt: 'Synthetic search excerpt.' },
          { title: 'Third-party lead', url: 'https://directory.example/person', excerpt: 'Not an institutional source.' },
        ];
      },
    },
    repository: { async save(candidate) { saved.push(candidate); } },
    options: {
      officialHostsByRegion: { 'Country A': ['www.countrya.edu'], 'Country B': ['www.countryb.ac.uk'] },
      countryCodesByRegion: { 'Country A': 'AA', 'Country B': 'BB' },
      now: () => new Date('2026-10-19T12:00:00.000Z'),
    },
  });

  assert.equal(result.searches, 4);
  assert.equal(result.saved, 2);
  assert.equal(result.rejected, 4);
  assert.equal(queried.length, 4);
  assert.ok(queried.some((query) => query.includes('Country A')));
  assert.ok(queried.some((query) => query.includes('Country B')));
  assert.deepEqual(saved.map((candidate) => candidate.country), ['Country A', 'Country B']);
  assert.ok(saved.every((candidate) => candidate.status === 'needs-evidence' && !candidate.approvedForSending));
  assert.ok(saved.every((candidate) => candidate.officialProfileUrl === undefined));
  assert.ok(saved.every((candidate) => candidate.discoveryEvidence?.[0]?.verification === 'unverified'));
  assert.ok(saved.every((candidate) => candidate.discoveryEvidence?.[0]?.sourceUrl === `https://www.${candidate.country === 'Country A' ? 'countrya.edu' : 'countryb.ac.uk'}/people/professor`));
  assert.ok(saved.every((candidate) => candidate.discoveryEvidence?.[0]?.retrievedAt === '2026-10-19T12:00:00.000Z'));
  assert.ok(saved.every((candidate) => candidate.programUrl === undefined && candidate.officialEmail === undefined));
});

test('discovery refuses to silently skip a configured region without reviewed official hosts', async () => {
  await assert.rejects(discoverProfessorCandidates({
    profile,
    provider: { async search() { return []; } },
    repository: { async save() {} },
    options: { officialHostsByRegion: { 'Country A': ['www.countrya.edu'] } },
  }), /No reviewed official institution hosts configured for region: Country B/);
});

test('discovery rejects broad public-suffix allowlists before searching', async () => {
  let searches = 0;
  await assert.rejects(discoverProfessorCandidates({
    profile,
    provider: { async search() { searches += 1; return []; } },
    repository: { async save() {} },
    options: { officialHostsByRegion: { 'Country A': ['co.uk'], 'Country B': ['www.countryb.ac.uk'] } },
  }), /Invalid or overly broad official host: co\.uk/);
  assert.equal(searches, 0);
});

test('Brave adapter authenticates, requests a bounded result count, and filters unsafe URLs', async () => {
  let requestUrl = '';
  let requestHeaders: Headers | undefined;
  const provider = new BraveSearchProvider('synthetic-token', async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ web: { results: [
      { title: 'Official result', url: 'https://university.example.edu/professor', description: 'Synthetic snippet.' },
      { title: 'Unsafe result', url: 'http://university.example.edu/professor', description: 'Synthetic snippet.' },
      { title: 'Malformed record', url: 'https://university.example.edu/other' },
    ] } }), { status: 200 });
  });
  const results = await provider.search('synthetic query', { countryCode: 'gb', count: 50 });
  const parsedUrl = new URL(requestUrl);
  assert.equal(parsedUrl.searchParams.get('count'), '20');
  assert.equal(parsedUrl.searchParams.get('country'), 'GB');
  assert.equal(requestHeaders?.get('X-Subscription-Token'), 'synthetic-token');
  assert.deepEqual(results, [{ title: 'Official result', url: 'https://university.example.edu/professor', excerpt: 'Synthetic snippet.' }]);
});

test('Brave adapter fails clearly when credentials are missing without exposing credentials', async () => {
  const provider = new BraveSearchProvider(undefined);
  await assert.rejects(provider.search('synthetic query'), /SEARCH_PROVIDER_API_KEY must be configured/);
});
