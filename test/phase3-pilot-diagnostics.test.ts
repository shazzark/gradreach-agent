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
    await appendPhase3ResultDiagnostic({
      country: 'South Korea', hostname: 'cs.kaist.ac.kr', outcome: 'rejected', rejectionReasons: ['not_professor_profile'],
    }, path);

    await assert.rejects((async () => {
      await appendPhase3ResultDiagnostic({
        country: 'New Zealand', hostname: 'www.cs.auckland.ac.nz', outcome: 'rejected', rejectionReasons: ['invalid_content'],
      }, path);
      throw new Error('later result processing failed');
    })(), /later result processing failed/);

    const records = (await readFile(path, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 3);
    assert.deepEqual(records.map(({ country, hostname, outcome, rejectionReasons }) => ({ country, hostname, outcome, rejectionReasons })), [
      { country: 'Japan', hostname: 'outside.example.edu', outcome: 'rejected', rejectionReasons: ['exact_host'] },
      { country: 'South Korea', hostname: 'cs.kaist.ac.kr', outcome: 'rejected', rejectionReasons: ['not_professor_profile'] },
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

test('page failure diagnostics retain safe path and error fields while dropping query secrets and unknown codes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gradreach-phase3-safe-failure-'));
  const path = join(directory, 'result-diagnostics.jsonl');
  try {
    await appendPhase3ResultDiagnostic({
      country: 'South Korea', hostname: 'cs.kaist.ac.kr', outcome: 'fetch_failed',
      rejectionReasons: ['network_error'], resourcePath: '/people/professor?token=private-value',
      errorName: 'FetchError', errorCode: 'ECONNRESET', causeName: 'TypeError', causeCode: 'ECONNRESET',
    }, path);
    await appendPhase3ResultDiagnostic({
      country: 'South Korea', hostname: 'cs.kaist.ac.kr', outcome: 'fetch_failed',
      rejectionReasons: ['http_status'], resourcePath: '/people/missing#private-fragment', statusCode: 503,
      errorName: 'NotAllowedError', errorCode: 'private-credential', causeName: 'UnknownError', causeCode: 'private-credential',
    }, path);

    const output = await readFile(path, 'utf8');
    const records = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(records.map((record) => Object.fromEntries(Object.entries({
      resourcePath: record.resourcePath,
      statusCode: record.statusCode,
      errorName: record.errorName,
      errorCode: record.errorCode,
      causeName: record.causeName,
      causeCode: record.causeCode,
    }).filter(([, value]) => value !== undefined))), [
      { resourcePath: '/people/professor', errorName: 'FetchError', errorCode: 'ECONNRESET', causeName: 'TypeError', causeCode: 'ECONNRESET' },
      { resourcePath: '/people/missing', statusCode: 503 },
    ]);
    for (const secret of ['private-value', 'private-fragment', 'private-credential', '?token', '#private']) {
      assert.equal(output.includes(secret), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
