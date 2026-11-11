import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';
import { planDiscoveryPreviewContinuation } from '../src/application/discovery-preview-continuation.ts';

test('continuation keeps saved order, excludes prior attempts, records missing hosts, and caps batches at five', () => {
  const plan = planDiscoveryPreviewContinuation({
    countries: ['Canada', 'Belgium', 'Australia', 'Holy See (Vatican City)', 'China', 'Japan', 'New Zealand'],
    afterCountry: 'Belgium',
    verifiedHosts: OFFICIAL_HOSTS_BY_REGION,
    attemptedCountries: ['Australia'],
  });
  assert.equal(plan.anchorFound, true);
  assert.deepEqual(plan.attemptedCountries, ['China', 'Japan', 'New Zealand']);
  assert.deepEqual(plan.skipped, [
    { country: 'Australia', reason: 'already_tested_no_retry' },
    { country: 'Holy See (Vatican City)', reason: 'no_verified_official_hosts' },
  ]);
  assert.deepEqual(plan.batches, [['China', 'Japan', 'New Zealand']]);
  assert.ok(plan.batches.every((batch) => batch.length <= 5));
});

test('continuation fails closed when the anchor is absent or batch size exceeds five', () => {
  assert.equal(planDiscoveryPreviewContinuation({ countries: ['Canada'], afterCountry: 'Belgium', verifiedHosts: OFFICIAL_HOSTS_BY_REGION, attemptedCountries: [] }).anchorFound, false);
  assert.throws(() => planDiscoveryPreviewContinuation({ countries: ['Canada', 'Belgium'], afterCountry: 'Canada', verifiedHosts: OFFICIAL_HOSTS_BY_REGION, attemptedCountries: [], batchSize: 6 }), /batchSize/);
});
