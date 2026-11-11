import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { DEFAULT_DISCOVERY_SCHEDULE, DISCOVERY_LIMITS, discoverySlot, inspectSavedUnreviewedLeads, runAutomaticDiscovery, selectNextDiscoveryBatch, validateDiscoverySchedule, type DiscoveryRun, type DiscoverySchedule } from '../src/application/automatic-discovery.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';
import { firstVerifiedTargetCountries, nextVerifiedTargetCountries } from '../src/domain/discovery-country-coverage.ts';

const profile = parseApplicantProfile({ applicant: {
  fullName: '', email: '', phone: '', nationality: '', currentLocation: '',
  degree: { title: '', institution: '', country: '', graduationYear: null, classification: '', gpa: null, gpaScale: null, gradingScaleDocument: '' },
  target: { degreeLevel: 'masters', intake: '2027', fields: ['Computer Science'], researchInterests: ['Distributed Systems'], countries: ['Japan'], fundingTypes: ['scholarship'], timezone: 'Africa/Lagos' },
  englishEvidence: { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' },
  documents: { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] },
} });

function candidate(id: string): ProfessorCandidate {
  return { id, name: `Professor ${id}`, professorName: `Professor ${id}`, institution: 'Kyoto University', country: 'Japan',
    leadType: 'professor_profile', officialProfileUrl: `https://www.kurims.kyoto-u.ac.jp/${id}`, status: 'needs-evidence', approvedForSending: false, priority: 0 };
}

function fakeRepos(candidates: ProfessorCandidate[], schedule: DiscoverySchedule, savedProfile = profile) {
  const runs = new Map<string, DiscoveryRun>();
  const checks = new Map<string, unknown>();
  let candidateSaves = 0;
  let savedSchedule = structuredClone(schedule);
  return {
    repositories: {
      candidates: { async list() { return candidates; }, async save() { candidateSaves += 1; } },
      profile: { async get() { return savedProfile; } },
      schedule: { async get() { return savedSchedule; }, async save(value: DiscoverySchedule) { savedSchedule = structuredClone(value); } },
      runs: { async list(limit: number) { return [...runs.values()].slice(0, limit); }, async claim(run: DiscoveryRun) { if (runs.has(run.id)) return false; runs.set(run.id, run); return true; }, async finish(run: DiscoveryRun) { runs.set(run.id, run); } },
      checks: { async has(id: string, runId: string) { return checks.has(`${runId}:${id}`); }, async list(limit: number) { return [...checks.values()].slice(0, limit) as never[]; }, async save(check: { id: string }) { checks.set(check.id, check); }, },
    }, runs, checks, get candidateSaves() { return candidateSaves; },
    get schedule() { return savedSchedule; },
  };
}

test('country coverage records the 42 evidence-backed countries and leaves three unsupported', () => {
  const verified = Object.keys(OFFICIAL_HOSTS_BY_REGION);
  const configured = [...verified, 'Holy See', 'Monaco', 'San Marino'];
  assert.equal(configured.length, 45);
  assert.equal(configured.filter((country) => Object.hasOwn(OFFICIAL_HOSTS_BY_REGION, country)).length, 42);
  assert.deepEqual(configured.filter((country) => !Object.hasOwn(OFFICIAL_HOSTS_BY_REGION, country)), ['Holy See', 'Monaco', 'San Marino']);
});

test('manual batch selects at most five verified countries in saved profile order', () => {
  assert.deepEqual(firstVerifiedTargetCountries(['Japan', 'Holy See', 'South Korea', 'Canada', 'Monaco', 'Belgium'], OFFICIAL_HOSTS_BY_REGION),
    ['Japan', 'South Korea', 'Canada', 'Belgium']);
  assert.throws(() => firstVerifiedTargetCountries(['Japan'], OFFICIAL_HOSTS_BY_REGION, 0), /limit/);
});

test('manual batch cursor selects the next five verified countries without repeating earlier countries', () => {
  const countries = ['Belgium', 'Holy See', 'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Czechia', 'Denmark', 'Estonia'];
  assert.deepEqual(nextVerifiedTargetCountries(countries, OFFICIAL_HOSTS_BY_REGION, 'Denmark'), ['Estonia']);
  assert.deepEqual(nextVerifiedTargetCountries(countries, OFFICIAL_HOSTS_BY_REGION, 'Belgium', 3), [
    'Bosnia and Herzegovina', 'Bulgaria', 'Croatia',
  ]);
  assert.deepEqual(nextVerifiedTargetCountries(
    ['Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy', 'Latvia', 'Liechtenstein'],
    OFFICIAL_HOSTS_BY_REGION, 'Greece', 5, ['Italy'],
  ), ['Hungary', 'Iceland', 'Ireland', 'Latvia', 'Liechtenstein']);
  assert.throws(() => nextVerifiedTargetCountries(countries, OFFICIAL_HOSTS_BY_REGION, 'Holy See'), /verified host/);
  assert.throws(() => nextVerifiedTargetCountries(countries, OFFICIAL_HOSTS_BY_REGION, 'Belgium', 0), /limit/);
});

test('schedule defaults disabled, paused, and starts in Africa/Lagos', () => {
  assert.deepEqual(DEFAULT_DISCOVERY_SCHEDULE, { enabled: false, paused: true, frequency: 'weekly', dayOfWeek: 1, time: '09:00', timeZone: 'Africa/Lagos', countries: [] });
});

test('frequency, timezone, configured-country selection, and request limits are validated', () => {
  assert.equal(discoverySlot({ ...DEFAULT_DISCOVERY_SCHEDULE, frequency: 'daily', time: '09:00' }, new Date('2026-11-04T08:00:00.000Z')), '2026-11-04T09:00[Africa/Lagos]');
  assert.equal(discoverySlot({ ...DEFAULT_DISCOVERY_SCHEDULE, time: '09:00', dayOfWeek: 1 }, new Date('2026-11-04T08:00:00.000Z')), undefined);
  assert.throws(() => validateDiscoverySchedule({ ...DEFAULT_DISCOVERY_SCHEDULE, timeZone: 'Mars/Olympus' }, ['Japan']), /timezone/i);
  assert.throws(() => validateDiscoverySchedule({ ...DEFAULT_DISCOVERY_SCHEDULE, countries: ['Monaco'] }, ['Japan']), /configured countries/i);
  assert.deepEqual(DISCOVERY_LIMITS, { searchesPerRun: 1, resultsPerSearch: 3, inspectionsPerRun: 5 });
});

test('pause blocks provider calls and a due run inspects at most five pages without changing candidates', async () => {
  const savedCandidates = Array.from({ length: 6 }, (_, index) => candidate(`lead-${index}`));
  const humanDecided = { ...candidate('accepted-by-human'), discoveryReview: { decision: 'accepted' as const, reviewedAt: '2026-11-03T10:00:00.000Z' } };
  const humanApproved = { ...candidate('approved-by-human'), status: 'approved' as const, approvedForSending: true, approvedAt: '2026-11-03T10:00:00.000Z' };
  savedCandidates.push(humanDecided, humanApproved);
  const before = structuredClone(savedCandidates);
  const data = fakeRepos(savedCandidates, { ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: true, sweepOnce: true, frequency: 'daily', countries: ['Japan'] });
  let searches = 0;
  let fetches = 0;
  const common = {
    repositories: data.repositories,
    configuredCountries: ['Japan'], verifiedCountries: ['Japan'],
    officialHostsByRegion: Object.fromEntries(Object.entries(OFFICIAL_HOSTS_BY_REGION).map(([country, hosts]) => [country, [...hosts]])),
    countryCodesByRegion: { Japan: 'JP' },
    provider: { async search(_query: string, options?: { count?: number }) { searches += 1; assert.equal(options?.count, 3); return []; } },
    fetchPage: async (url: string) => { fetches += 1; return { url, html: '<p>Research focuses on distributed computing systems and their applications.</p>' }; },
    now: new Date('2026-11-04T08:00:00.000Z'),
  };
  assert.equal((await runAutomaticDiscovery(common)).state, 'paused');
  assert.equal(searches, 0);
  data.repositories.schedule.get = async () => ({ ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: false, sweepOnce: true, frequency: 'daily', countries: ['Japan'] });
  const run = await runAutomaticDiscovery(common);
  assert.equal(run.state, 'completed');
  assert.equal(run.targetingMode, 'query_and_host');
  assert.equal(searches, 1);
  assert.equal(fetches, 5);
  assert.equal(run.counts.inspected, 5);
  assert.equal(data.schedule.enabled, false);
  assert.equal(data.schedule.paused, true);
  assert.deepEqual(data.schedule.countries, []);
  assert.equal(data.candidateSaves, 0);
  assert.deepEqual(savedCandidates, before);
  assert.deepEqual(savedCandidates.slice(-2), [humanDecided, humanApproved]);
});

test('scheduled discovery persists only bounded result rejection diagnostics with its run', async () => {
  const data = fakeRepos([], { ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: false, frequency: 'daily', countries: ['Japan'] });
  const result = await runAutomaticDiscovery({
    repositories: data.repositories,
    configuredCountries: ['Japan'], verifiedCountries: ['Japan'],
    officialHostsByRegion: { Japan: [...OFFICIAL_HOSTS_BY_REGION.Japan] }, countryCodesByRegion: { Japan: 'JP' },
    provider: { async search() { return [{ title: 'Synthetic result', url: 'https://outside.example.org/faculty?secret=query-canary', excerpt: 'Synthetic excerpt' }]; } },
    fetchPage: async (url) => ({ url, html: '' }),
    now: new Date('2026-11-04T08:00:00.000Z'),
  });
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.resultDiagnostics, [{ resultNumber: 1, stage: 'result_validation', reason: 'exact_host', observedHostname: 'outside.example.org', identityConfirmed: false, researchEvidenceFound: false, interestMatched: null }]);
  const stored = data.runs.get('discovery:2026-11-04T09:00[Africa/Lagos]');
  assert.deepEqual(stored?.resultDiagnostics, result.resultDiagnostics);
  assert.equal(JSON.stringify(stored).includes('query-canary'), false);
  assert.equal(JSON.stringify(stored).includes('Synthetic result'), false);
});

test('one-sweep daily run claims up to five saved-order countries with one search each', async () => {
  const countries = ['Belgium', 'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Czechia', 'Denmark', 'Estonia'];
  const savedProfile = { ...profile, applicant: { ...profile.applicant, target: { ...profile.applicant.target, countries } } };
  const data = fakeRepos([], { ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: false, sweepOnce: true,
    frequency: 'daily', countries: countries.slice(0, 5) }, savedProfile);
  const searched: string[] = [];
  const input = {
    repositories: data.repositories,
    configuredCountries: countries,
    verifiedCountries: countries,
    officialHostsByRegion: Object.fromEntries(countries.map((country) => [country, [...OFFICIAL_HOSTS_BY_REGION[country as keyof typeof OFFICIAL_HOSTS_BY_REGION]]])),
    countryCodesByRegion: { Belgium: 'BE', 'Bosnia and Herzegovina': 'BA', Bulgaria: 'BG', Croatia: 'HR', Czechia: 'CZ', Denmark: 'DK', Estonia: 'EE' },
    provider: { async search(_query: string, options?: { region?: string; count?: number }) {
      assert.equal(options?.count, 3);
      searched.push(options?.region ?? '');
      if (options?.region === 'Bulgaria') throw new Error('synthetic provider failure');
      return [];
    } },
    fetchPage: async (url: string) => ({ url, html: '' }),
    now: new Date('2026-11-04T08:00:00.000Z'),
  };
  const result = await runAutomaticDiscovery(input);
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.countries, countries.slice(0, 5));
  assert.deepEqual(searched, countries.slice(0, 5));
  assert.equal(result.counts.searches, 5);
  assert.deepEqual(result.countryOutcomes?.map(({ country, state }) => ({ country, state })), [
    { country: 'Belgium', state: 'completed' },
    { country: 'Bosnia and Herzegovina', state: 'completed' },
    { country: 'Bulgaria', state: 'failed' },
    { country: 'Croatia', state: 'completed' },
    { country: 'Czechia', state: 'completed' },
  ]);
  assert.equal(result.countryOutcomes?.find(({ country }) => country === 'Bulgaria')?.counts.searches, 1);
  assert.deepEqual(data.schedule.countries, countries.slice(5));
  assert.equal(data.runs.get(`discovery:${discoverySlot(data.schedule, input.now)!}`)?.state, 'completed');

  assert.equal((await runAutomaticDiscovery(input)).state, 'duplicate');
  assert.deepEqual(searched, countries.slice(0, 5), 'a repeated slot must not search again');
  const finalRun = await runAutomaticDiscovery({ ...input, now: new Date('2026-11-05T08:00:00.000Z') });
  assert.equal(finalRun.state, 'completed');
  assert.deepEqual(finalRun.countries, countries.slice(5));
  assert.deepEqual(searched, countries, 'the failed country must not be retried');
  assert.equal(data.schedule.enabled, false);
  assert.equal(data.schedule.paused, true);
  assert.deepEqual(data.schedule.countries, []);
});

test('dry-run batch selection skips prior attempts and fills the next five in saved order', () => {
  const configured = ['Belgium', 'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Czechia', 'Denmark', 'Estonia'];
  const schedule = { ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: false, sweepOnce: true,
    frequency: 'daily' as const, countries: configured.slice(0, 5) };
  const previous: DiscoveryRun[] = [
    { id: 'old-1', scheduledFor: '', startedAt: '', country: 'Belgium', state: 'failed', counts: { searches: 0, results: 0, saved: 0, duplicates: 0, rejections: 0, fetchFailures: 0, inspected: 0, inspectionFailures: 0 } },
    { id: 'old-2', scheduledFor: '', startedAt: '', country: 'Bosnia and Herzegovina', state: 'completed', counts: { searches: 0, results: 0, saved: 0, duplicates: 0, rejections: 0, fetchFailures: 0, inspected: 0, inspectionFailures: 0 } },
    { id: 'interrupted-batch', scheduledFor: '', startedAt: '', countries: configured.slice(0, 5), state: 'running', counts: { searches: 0, results: 0, saved: 0, duplicates: 0, rejections: 0, fetchFailures: 0, inspected: 0, inspectionFailures: 0 } },
  ];
  assert.deepEqual(selectNextDiscoveryBatch(schedule, configured, configured, previous), [
    'Bulgaria', 'Croatia', 'Czechia', 'Denmark', 'Estonia',
  ]);
});

test('automatic checks fail safely when no configured country has a verified host', async () => {
  const data = fakeRepos([], { ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: false, frequency: 'daily', countries: ['Japan'] });
  let searches = 0;
  const result = await runAutomaticDiscovery({
    repositories: data.repositories, configuredCountries: ['Japan'], verifiedCountries: [],
    officialHostsByRegion: {}, countryCodesByRegion: {}, provider: { async search() { searches += 1; return []; } },
    fetchPage: async (url: string) => ({ url, html: '' }), now: new Date('2026-11-04T08:00:00.000Z'),
  });
  assert.equal(result.state, 'failed');
  assert.equal('failureCode' in result ? result.failureCode : '', 'no_verified_country');
  assert.equal(searches, 0);
});

test('scheduled rechecks append dated recommendations and preserve saved candidate decisions', async () => {
  const saved = candidate('jane-doe');
  saved.professorName = 'Jane Doe';
  const before = structuredClone(saved);
  const data = fakeRepos([saved], { ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: false, frequency: 'daily', countries: ['Japan'] });
  const input = {
    repositories: data.repositories, configuredCountries: ['Japan'], verifiedCountries: ['Japan'],
    officialHostsByRegion: { Japan: [...OFFICIAL_HOSTS_BY_REGION.Japan] }, countryCodesByRegion: { Japan: 'JP' },
    provider: { async search() { return []; } },
    fetchPage: async (url: string) => ({ url, html: '<h1>Jane Doe</h1><p>Jane Doe is an Associate Professor who researches distributed systems that preserve service availability during regional network failures.</p>' }),
  };
  const first = await runAutomaticDiscovery({ ...input, now: new Date('2026-11-04T08:00:00.000Z') });
  const second = await runAutomaticDiscovery({ ...input, now: new Date('2026-11-05T08:00:00.000Z') });
  assert.equal(first.state, 'completed');
  assert.equal(second.state, 'completed');
  assert.equal(data.checks.size, 2);
  const records = [...data.checks.values()] as Array<{ checkedAt: string; evidencePackage: { researchQuote?: string; recommendation: string } }>;
  assert.deepEqual(records.map((record) => record.checkedAt).sort(), ['2026-11-04T08:00:00.000Z', '2026-11-05T08:00:00.000Z']);
  assert.ok(records.every((record) => record.evidencePackage.researchQuote?.includes('distributed systems')));
  assert.ok(records.every((record) => record.evidencePackage.recommendation === 'likely relevant'));
  assert.deepEqual(saved, before);
  assert.equal(data.candidateSaves, 0);
});

test('manual evidence inspection is search-free, inspects at most five leads, and preserves decisions', async () => {
  const undecided = Array.from({ length: 7 }, (_, index) => {
    const item = candidate(`manual-${index}`);
    item.professorName = index === 2 ? 'Missing Person' : 'Ada Lovelace';
    return item;
  });
  const humanDecided = { ...candidate('manual-decided'), discoveryReview: { decision: 'accepted' as const, reviewedAt: '2026-11-03T10:00:00.000Z' } };
  const humanApproved = { ...candidate('manual-approved'), status: 'approved' as const, approvedForSending: true, approvedAt: '2026-11-03T10:00:00.000Z' };
  const allCandidates = [...undecided, humanDecided, humanApproved];
  const before = structuredClone(allCandidates);
  const data = fakeRepos(allCandidates, DEFAULT_DISCOVERY_SCHEDULE);
  data.repositories.schedule.get = async () => { throw new Error('inspection must not consult or run the scheduler'); };
  let fetches = 0;
  const result = await inspectSavedUnreviewedLeads({
    repositories: data.repositories,
    verifiedCountries: ['Japan'],
    officialHostsByRegion: { Japan: [...OFFICIAL_HOSTS_BY_REGION.Japan] },
    now: new Date('2026-11-04T12:00:00.000Z'),
    async fetchPage(url) {
      fetches += 1;
      if (url.endsWith('manual-2')) return { url, html: '<h1>Group of researchers</h1><p>The group studies several areas of computing and technology.</p>' };
      if (url.endsWith('manual-1')) return { url, html: '<h1>Ada Lovelace</h1><p>Ada Lovelace is a Professor who researches quantum optics in modern laboratory applications around the world.</p>' };
      return { url, html: '<h1>Ada Lovelace</h1><p>Ada Lovelace is a Professor who researches distributed systems that preserve service availability during regional network failures.</p>' };
    },
  });
  assert.equal(fetches, 5);
  assert.equal(result.counts.searches, 0);
  assert.equal(result.counts.inspected, 5);
  assert.equal(result.matched, 3);
  assert.equal(result.uncertain, 1);
  assert.equal(result.unlikely, 1);
  assert.equal(result.pending, 2);
  assert.equal(data.checks.size, 5);
  assert.deepEqual(allCandidates, before);
});

test('manual evidence inspection records a failed fetch once without retrying', async () => {
  const saved = candidate('manual-failure');
  const data = fakeRepos([saved], DEFAULT_DISCOVERY_SCHEDULE);
  let fetches = 0;
  const result = await inspectSavedUnreviewedLeads({
    repositories: data.repositories,
    verifiedCountries: ['Japan'],
    officialHostsByRegion: { Japan: [...OFFICIAL_HOSTS_BY_REGION.Japan] },
    now: new Date('2026-11-04T12:00:00.000Z'),
    async fetchPage() { fetches += 1; throw new Error('offline'); },
  });
  assert.equal(fetches, 1);
  assert.equal(result.counts.inspected, 1);
  assert.equal(result.counts.inspectionFailures, 1);
  assert.equal(result.uncertain, 1);
  assert.equal(data.checks.size, 1);
});

test('run claim prevents a duplicate scheduled slot from searching again', async () => {
  const data = fakeRepos([], { ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: false, frequency: 'daily', countries: ['Japan'] });
  let searches = 0;
  const input = {
    repositories: data.repositories, configuredCountries: ['Japan'], verifiedCountries: ['Japan'],
    officialHostsByRegion: { Japan: [...OFFICIAL_HOSTS_BY_REGION.Japan] }, countryCodesByRegion: { Japan: 'JP' },
    provider: { async search() { searches += 1; return []; } }, fetchPage: async (url: string) => ({ url, html: '<p>Some substantive research content.</p>' }),
    now: new Date('2026-11-04T08:00:00.000Z'),
  };
  assert.equal((await runAutomaticDiscovery(input)).state, 'completed');
  assert.equal((await runAutomaticDiscovery(input)).state, 'duplicate');
  assert.equal(searches, 1);
});

test('scheduled discovery publishes bounded progress only after claiming and persisting its run', async () => {
  const data = fakeRepos([], { ...DEFAULT_DISCOVERY_SCHEDULE, enabled: true, paused: false, frequency: 'daily', countries: ['Japan'] });
  const events: Array<{ jobId: string; state: string; stage: string; completed?: number; total?: number }> = [];
  const result = await runAutomaticDiscovery({
    repositories: data.repositories, configuredCountries: ['Japan'], verifiedCountries: ['Japan'],
    officialHostsByRegion: { Japan: [...OFFICIAL_HOSTS_BY_REGION.Japan] }, countryCodesByRegion: { Japan: 'JP' },
    provider: { async search(_query, options) { assert.equal(options?.count, 3); return []; } },
    fetchPage: async (url: string) => ({ url, html: '<p>Research group</p>' }),
    now: new Date('2026-11-04T08:00:00.000Z'),
    onProgress(event) {
      assert.ok(data.runs.size > 0, 'run claim must precede transient progress');
      events.push(event);
    },
  });
  assert.equal(result.state, 'completed');
  assert.deepEqual(events.map(({ state, stage }) => `${state}:${stage}`), [
    'running:starting', 'running:searching', 'running:saving_candidates', 'running:persisting_checks', 'completed:completed',
  ]);
  assert.ok(events.every(({ jobId }) => /^discovery_[A-Za-z0-9_-]{1,64}$/.test(jobId)));
  assert.ok(events.every(({ total }) => total === 1 || total === 5));
  assert.ok(events.every(({ completed, total }) => completed === undefined || (total !== undefined && completed <= total)));
});
