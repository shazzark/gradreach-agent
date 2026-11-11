import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');

test('public welcome page offers workspace entry without importing private services or records', () => {
  assert.match(source, /href="\/workspace"/);
  assert.match(source, /absolute: 'GradReach \| Evidence-led graduate research'/);
  assert.doesNotMatch(source, /from ['"][^'"]*(?:owner-data|mongo-storage|application\/|domain\/)/);
  assert.doesNotMatch(source, /getOwnerWorkspace|connectMongoStorage|MONGODB_URI/);
});
