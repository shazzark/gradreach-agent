import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPhase3ResultDiagnostic } from '../src/infrastructure/phase3-pilot-diagnostics.ts';

test('pilot result diagnostics append independently and omit result content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gradreach-phase3-'));
  const path = join(directory, 'result-diagnostics.jsonl');
  try {
    await appendPhase3ResultDiagnostic({
      country: 'Japan', hostname: 'outside.example.edu', outcome: 'rejected', rejectionReasons: ['exact_host'],
    }, path);

    await assert.rejects((async () => {
      await appendPhase3ResultDiagnostic({
        country: 'New Zealand', hostname: 'www.cs.auckland.ac.nz', outcome: 'rejected', rejectionReasons: ['invalid_content'],
      }, path);
      throw new Error('later result processing failed');
    })(), /later result processing failed/);

    const records = (await readFile(path, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(({ country, hostname, outcome, rejectionReasons }) => ({ country, hostname, outcome, rejectionReasons })), [
      { country: 'Japan', hostname: 'outside.example.edu', outcome: 'rejected', rejectionReasons: ['exact_host'] },
      { country: 'New Zealand', hostname: 'www.cs.auckland.ac.nz', outcome: 'rejected', rejectionReasons: ['invalid_content'] },
    ]);
    const serialized = JSON.stringify(records);
    for (const privateValue of ['https://', '?query', 'title text', 'excerpt text', 'response body']) {
      assert.equal(serialized.includes(privateValue), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pilot result diagnostics reject host fields that could contain URLs', async () => {
  await assert.rejects(appendPhase3ResultDiagnostic({
    country: 'Japan', hostname: 'university.example.edu/path?query=private', outcome: 'rejected', rejectionReasons: ['exact_host'],
  }, join(tmpdir(), 'unused-result-diagnostics.jsonl')), /Invalid diagnostic hostname/);
});
