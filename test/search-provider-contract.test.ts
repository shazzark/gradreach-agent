import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BraveSearchProvider } from '../src/infrastructure/brave-search-provider.ts';
import { SanitizedIntegrationError } from '../src/infrastructure/sanitized-failure.ts';

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`./fixtures/search-provider/${name}`, import.meta.url), 'utf8')) as unknown;

function fixtureProvider(payload: unknown, onRejectedResult?: (checks: { exactHost: boolean; title: boolean; excerpt: boolean; hostname: string | null }) => void) {
  return new BraveSearchProvider('fixture-only-key', async () => Response.json(payload))
    .searchPage('fixture query that must not enter metadata', {
      count: 2,
      countryCode: 'gb',
      targetingMode: 'api_country',
      ...(onRejectedResult ? { onRejectedResult } : {}),
    });
}

test('provider contract normalizes successful results and reports only safe request metadata', async () => {
  const page = await fixtureProvider(await fixture('brave-success.json'));
  assert.equal(page.provider, 'brave');
  assert.equal(page.results.length, 2);
  assert.equal(page.results[0]?.provider, 'brave');
  assert.equal(page.results[0]?.title, 'Synthetic university profile');
  assert.equal(page.results[0]?.url, 'https://university.example.edu/faculty/one');
  assert.equal(page.results[0]?.snippet, 'A mocked snippet about distributed systems.');
  assert.equal(page.results[0]?.excerpt, page.results[0]?.snippet);
  assert.deepEqual(page.requestMetadata, {
    requestedCount: 2,
    providerResultCount: 3,
    acceptedResultCount: 2,
    offset: 0,
    paginationKnown: true,
    moreResultsAvailable: true,
    countryCode: 'GB',
    targetingMode: 'api_country',
  });
  assert.equal(JSON.stringify(page.requestMetadata).includes('fixture query'), false);
  assert.equal(JSON.stringify(page.requestMetadata).includes('fixture-only-key'), false);
});

test('provider contract accepts a valid empty result page', async () => {
  const page = await fixtureProvider(await fixture('brave-empty.json'));
  assert.deepEqual(page.results, []);
  assert.equal(page.requestMetadata?.acceptedResultCount, 0);
  assert.equal(page.moreResultsAvailable, false);
});

test('provider contract rejects structurally malformed result arrays with a safe error', async () => {
  await assert.rejects(fixtureProvider(await fixture('brave-malformed.json')), (error: unknown) => {
    assert.ok(error instanceof SanitizedIntegrationError);
    assert.equal(error.failure.kind, 'invalid_content');
    assert.equal(error.message.includes('fixture-only-key'), false);
    return true;
  });
});

test('provider contract filters incomplete object results through the rejection callback', async () => {
  const rejected: Array<{ exactHost: boolean; title: boolean; excerpt: boolean; hostname: string | null }> = [];
  const page = await fixtureProvider({ web: { results: [
    { title: 'Incomplete item', url: 'https://university.example.edu/faculty/incomplete' },
    { title: 'Complete item', url: 'https://university.example.edu/faculty/complete', description: 'Fixture snippet.' },
  ] } }, (checks) => { rejected.push(checks); });
  assert.equal(page.results.length, 1);
  assert.deepEqual(rejected, [{ exactHost: false, title: false, excerpt: true, hostname: 'university.example.edu' }]);
});

test('provider errors expose sanitized status metadata only', async () => {
  const provider = new BraveSearchProvider('fixture-only-key', async () => new Response('private fixture-only-key body', { status: 503 }));
  await assert.rejects(provider.searchPage('fixture query', { count: 2 }), (error: unknown) => {
    assert.ok(error instanceof SanitizedIntegrationError);
    assert.equal(error.failure.kind, 'http_status');
    assert.equal(error.failure.statusCode, 503);
    assert.equal(JSON.stringify(error.failure).includes('fixture-only-key'), false);
    assert.equal(JSON.stringify(error.failure).includes('fixture query'), false);
    return true;
  });
});

test('provider timeout errors are classified without retaining raw error text', async () => {
  const provider = new BraveSearchProvider('fixture-only-key', async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    const error = new Error('timeout included fixture-only-key and query text') as Error & { code: string };
    error.name = 'TimeoutError';
    error.code = 'ETIMEDOUT';
    throw error;
  });
  await assert.rejects(provider.searchPage('fixture query', { count: 2 }), (error: unknown) => {
    assert.ok(error instanceof SanitizedIntegrationError);
    assert.equal(error.failure.kind, 'timeout');
    assert.equal(JSON.stringify(error.failure).includes('fixture-only-key'), false);
    assert.equal(JSON.stringify(error.failure).includes('fixture query'), false);
    return true;
  });
});
