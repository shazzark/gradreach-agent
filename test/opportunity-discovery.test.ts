import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import { runOpportunityDiscovery } from '../src/application/opportunity-discovery.ts';
import type { OpportunityDiscoveryRun } from '../src/domain/opportunity-discovery.ts';
import type { SearchProvider } from '../src/infrastructure/brave-search-provider.ts';

const profile = parseApplicantProfile(JSON.parse(await readFile(new URL('../private.profile.example.json', import.meta.url), 'utf8')));
profile.applicant.target.countries = ['Belgium'];
profile.applicant.target.researchInterests = ['distributed systems', 'privacy'];

function harness(provider: SearchProvider) {
  let claimed: OpportunityDiscoveryRun | undefined;
  let writes = 0;
  const records: unknown[] = [];
  const repositories = {
    opportunityDiscoveryRuns: {
      async claim(run: OpportunityDiscoveryRun) { if (claimed) return false; claimed = structuredClone(run); return true; },
      async recordProgress(run: OpportunityDiscoveryRun) { claimed = structuredClone(run); },
      async recordSource() {},
      async finish(run: OpportunityDiscoveryRun) { claimed = structuredClone(run); return true; },
    },
    programs: { async saveDiscovered(program: unknown) { records.push(program); writes++; return { id: `saved-${writes}`, duplicate: false }; } },
  };
  return { repositories, records, get run() { return claimed; } };
}

test('opportunity discovery uses official source pages, matches any saved interest, and stores only bounded history', async () => {
  let requests = 0;
  const provider: SearchProvider = {
    async search(query) { requests++; assert.match(query, /site:eng\.kuleuven\.be/); assert.match(query, /distributed systems/); return [{ title: 'provider title', url: 'https://eng.kuleuven.be/programmes/systems', excerpt: 'private provider response' }]; },
  };
  const fixture = harness(provider);
  const result = await runOpportunityDiscovery({
    repositories: fixture.repositories as never, profile, provider, requestId: '11111111-1111-4111-8111-111111111111',
    now: () => new Date('2026-11-11T09:00:00Z'),
    fetchPage: async () => ({ url: 'https://eng.kuleuven.be/programmes/systems', html: '<html><title>Systems MSc | KU Leuven</title><h1>Systems MSc</h1><p>Research explores distributed systems. Deadline and funding are not stated.</p></html>' }),
  });
  assert.equal(requests, 4);
  assert.equal(result.counts.saved, 1);
  assert.equal(fixture.records.length, 1);
  const saved = fixture.records[0] as Record<string, unknown>;
  assert.equal(saved.name, 'Systems MSc');
  assert.equal(saved.degree, 'MSc');
  assert.equal(saved.field, undefined);
  assert.equal(saved.reviewStatus, 'pending');
  assert.equal(saved.fundingDetails, undefined);
  assert.equal(saved.deadline, undefined);
  assert.equal(result.sources[0]?.counts.interestMatches, 1);
  assert.equal(JSON.stringify(result).includes('distributed systems'), false);
  assert.equal(JSON.stringify(result).includes('private provider response'), false);
  assert.equal(JSON.stringify(result).includes('https://eng.kuleuven.be/programmes/systems'), false);
});

test('opportunity discovery rejects unverified hosts and does not retry a failed provider request', async () => {
  let requests = 0;
  let fetches = 0;
  const provider: SearchProvider = { async search() { requests++; throw new Error('secret token and raw provider payload'); } };
  const fixture = harness(provider);
  const result = await runOpportunityDiscovery({
    repositories: fixture.repositories as never, profile, provider, requestId: '22222222-2222-4222-8222-222222222222',
    now: () => new Date('2026-11-11T09:00:00Z'), fetchPage: async () => { fetches++; throw new Error('must not fetch'); },
  });
  assert.equal(requests, 4);
  assert.equal(fetches, 0);
  assert.equal(result.counts.failures, 4);
  assert.equal(result.state, 'failed');
  assert.equal(JSON.stringify(result).includes('secret token'), false);
  assert.equal(JSON.stringify(result).includes('raw provider payload'), false);
});

test('repeated request ID is claimed once and performs no second provider request', async () => {
  let requests = 0;
  const provider: SearchProvider = { async search() { requests++; return []; } };
  const fixture = harness(provider);
  const input = { repositories: fixture.repositories as never, profile, provider, requestId: '33333333-3333-4333-8333-333333333333' };
  await runOpportunityDiscovery(input);
  const callsAfterFirst = requests;
  const duplicate = await runOpportunityDiscovery(input);
  assert.equal(requests, callsAfterFirst);
  assert.equal(duplicate.state, 'running');
});

test('already-saved official source is recorded as a duplicate instead of another saved opportunity', async () => {
  const provider: SearchProvider = { async search() { return [{ title: 'untrusted title', url: 'https://eng.kuleuven.be/programmes/systems', excerpt: 'ignored provider excerpt' }]; } };
  const fixture = harness(provider);
  (fixture.repositories.programs as { saveDiscovered(program: unknown): Promise<{ id: string; duplicate: boolean; reason?: 'source' | 'identity' }> }).saveDiscovered = async () => ({ id: 'existing-program', duplicate: true, reason: 'source' });
  const result = await runOpportunityDiscovery({
    repositories: fixture.repositories as never, profile, provider, requestId: '44444444-4444-4444-8444-444444444444',
    now: () => new Date('2026-11-11T09:00:00Z'),
    fetchPage: async () => ({ url: 'https://eng.kuleuven.be/programmes/systems', html: '<h1>Systems MSc</h1><p>Research explores distributed systems.</p>' }),
  });
  assert.equal(result.counts.duplicates, 1);
  assert.equal(result.counts.saved, 0);
  assert.equal(fixture.records.length, 0);
  assert.ok(result.sources[0]?.stopReasons.includes('duplicate_source'));
});
