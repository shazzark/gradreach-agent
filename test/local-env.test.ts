import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadLocalEnv } from '../src/infrastructure/local-env.ts';

test('loads local settings, supports common .env syntax, and preserves existing process values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gradreach-env-'));
  const path = join(directory, '.env');
  const keys = ['GRADREACH_ENV_TEST_PLAIN', 'GRADREACH_ENV_TEST_QUOTED', 'GRADREACH_ENV_TEST_EXPORT', 'GRADREACH_ENV_TEST_PRECEDENCE'];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.GRADREACH_ENV_TEST_PRECEDENCE = 'process-value';
    await writeFile(path, [
      '# comment',
      'GRADREACH_ENV_TEST_PLAIN=plain-value # inline comment',
      'GRADREACH_ENV_TEST_QUOTED="line one\\nline two"',
      'export GRADREACH_ENV_TEST_EXPORT=exported',
      'GRADREACH_ENV_TEST_PRECEDENCE=file-value',
      'invalid line',
    ].join('\n'));

    await loadLocalEnv(path);

    assert.equal(process.env.GRADREACH_ENV_TEST_PLAIN, 'plain-value');
    assert.equal(process.env.GRADREACH_ENV_TEST_QUOTED, 'line one\nline two');
    assert.equal(process.env.GRADREACH_ENV_TEST_EXPORT, 'exported');
    assert.equal(process.env.GRADREACH_ENV_TEST_PRECEDENCE, 'process-value');
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('an absent .env file is optional', async () => {
  await assert.doesNotReject(loadLocalEnv(join(tmpdir(), 'gradreach-missing-env', '.env')));
});
