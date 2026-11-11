import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedBatchOptions } from '../src/interfaces/discover-professor-batch.ts';

test('batch cursor accepts separated and inline country values', () => {
  assert.deepEqual(requestedBatchOptions(['--after', 'Denmark']), { afterCountry: 'Denmark', skipCountries: [] });
  assert.deepEqual(requestedBatchOptions(['--after=Denmark']), { afterCountry: 'Denmark', skipCountries: [] });
  assert.deepEqual(requestedBatchOptions([]), { skipCountries: [] });
});

test('batch arguments can skip previously attempted countries', () => {
  assert.deepEqual(requestedBatchOptions(['--after', 'Greece', '--skip', 'Italy', '--skip=Portugal']), {
    afterCountry: 'Greece', skipCountries: ['Italy', 'Portugal'],
  });
});

test('batch cursor rejects missing, duplicate, and empty values', () => {
  assert.throws(() => requestedBatchOptions(['--after']), /requires a country name/);
  assert.throws(() => requestedBatchOptions(['--after', 'Denmark', '--after=France']), /only once/);
  assert.throws(() => requestedBatchOptions(['Denmark']), /Unexpected discovery batch argument/);
  assert.throws(() => requestedBatchOptions(['--after=']), /requires a verified country/);
  assert.throws(() => requestedBatchOptions(['--skip', 'Italy', '--skip=Italy']), /each --skip country only once/);
});
