import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPhase3ResultDiagnostic, storedDiscoveryResultDiagnostic } from '../src/infrastructure/phase3-pilot-diagnostics.ts';

test('durable result diagnostic projection preserves fetch status and sanitized transport code only', () => {
  assert.deepEqual(storedDiscoveryResultDiagnostic({
    stage: 'official_page_fetch', country: 'Canada', hostname: 'university.example.edu', outcome: 'fetch_failed',
    rejectionReasons: ['timeout'], statusCode: 403, errorCode: 'ETIMEDOUT', causeCode: 'private-error-canary',
    resourcePath: '/path?private-query-canary',
  }, 3), {
    resultNumber: 3, stage: 'official_page_fetch', reason: 'timeout', statusCode: 403, networkCode: 'ETIMEDOUT',
  });
  assert.equal(storedDiscoveryResultDiagnostic({
    stage: 'official_page_fetch', country: 'Canada', hostname: null, outcome: 'fetch_failed',
    rejectionReasons: ['timeout'], errorCode: 'private-error-canary',
  }, 4), undefined);
});

test('durable traversal diagnostics keep only bounded reason codes and counts', () => {
  const safe = storedDiscoveryResultDiagnostic({
    stage: 'professor_evidence', country: 'Canada', hostname: 'uwaterloo.ca', outcome: 'rejected',
    rejectionReasons: ['no_named_professor_identity'], sameHostProfileLinksFound: 47,
    sameHostProfileLinksConsidered: 100,
    selectedProfileLinks: [{ rank: 1, reasons: ['profile_url_pattern', 'academic_role'] }],
    sameHostProfileLinksFetched: 1,
    profileLinkRejections: [
      { reason: 'excluded_navigation_or_nonacademic', count: 30 },
      { reason: 'insufficient_profile_signals', count: 23 },
    ],
  }, 1);
  assert.equal(safe?.sameHostProfileLinksConsidered, 100);
  assert.equal(safe?.sameHostProfileLinksFetched, 1);
  assert.deepEqual(safe?.profileLinkRejections, [
    { reason: 'excluded_navigation_or_nonacademic', count: 30 },
    { reason: 'insufficient_profile_signals', count: 23 },
  ]);
  assert.equal(JSON.stringify(safe).includes('academic_role'), true);
  assert.equal(JSON.stringify(safe).includes('query'), false);
  assert.equal(JSON.stringify(safe).includes('interests'), false);
  assert.equal(JSON.stringify(safe).includes('credentials'), false);
});

test('durable research-link diagnostics require non-overlapping counts within the considered set', () => {
  const projected = storedDiscoveryResultDiagnostic({
    stage: 'professor_evidence', country: 'Canada', hostname: 'uwaterloo.ca', outcome: 'rejected',
    rejectionReasons: ['no_official_research_evidence'], professorIdentityEstablished: true,
    linkedResearchPagesConsidered: 10, linkedResearchPagesFound: 3,
    linkedResearchPagesSelected: [{ rank: 1, reasons: ['research_anchor_text', 'research_section_context'] }],
    linkedResearchPagesFetched: 1,
    researchPageLinkRejections: [
      { reason: 'non_research_destination', count: 2 },
      { reason: 'no_research_signal', count: 5 },
    ],
  }, 1);
  assert.equal(projected?.linkedResearchPagesConsidered, 10);
  assert.equal(projected?.linkedResearchPagesFound, 3);
  assert.equal(projected?.linkedResearchPagesSelected?.length, 1);
  assert.equal(projected?.linkedResearchPagesFetched, 1);
  assert.equal(projected?.researchPageLinkRejections?.reduce((sum, item) => sum + item.count, 0), 7);
  assert.equal((projected?.linkedResearchPagesFound ?? 0) + 7, projected?.linkedResearchPagesConsidered);

  const inconsistent = storedDiscoveryResultDiagnostic({
    stage: 'professor_evidence', country: 'Canada', hostname: 'uwaterloo.ca', outcome: 'rejected',
    rejectionReasons: ['no_official_research_evidence'], linkedResearchPagesConsidered: 2,
    linkedResearchPagesFound: 3, linkedResearchPagesSelected: [{ rank: 1, reasons: ['research_url_pattern'] }],
    linkedResearchPagesFetched: 1, researchPageLinkRejections: [],
  }, 1);
  assert.equal(inconsistent?.linkedResearchPagesConsidered, undefined);
  assert.equal(inconsistent?.linkedResearchPagesFound, undefined);
  assert.equal(inconsistent?.linkedResearchPagesSelected, undefined);
  assert.equal(inconsistent?.linkedResearchPagesFetched, undefined);
});

test('pilot result diagnostics append independently and omit result content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gradreach-phase3-'));
  const path = join(directory, 'result-diagnostics.jsonl');
  try {
    await appendPhase3ResultDiagnostic({
      country: 'Japan', hostname: 'outside.example.edu', outcome: 'rejected', rejectionReasons: ['exact_host'],
    }, path);
    await appendPhase3ResultDiagnostic({
      stage: 'professor_evidence', country: 'South Korea', hostname: 'cs.kaist.ac.kr', outcome: 'rejected', rejectionReasons: ['no_named_professor_identity'],
    }, path);
    await appendPhase3ResultDiagnostic({
      stage: 'professor_evidence', country: 'Japan', hostname: 'www.kurims.kyoto-u.ac.jp', outcome: 'rejected', rejectionReasons: ['no_official_research_evidence'],
    }, path);

    await assert.rejects((async () => {
      await appendPhase3ResultDiagnostic({
        country: 'New Zealand', hostname: 'www.cs.auckland.ac.nz', outcome: 'rejected', rejectionReasons: ['invalid_content'],
      }, path);
      throw new Error('later result processing failed');
    })(), /later result processing failed/);

    const records = (await readFile(path, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 4);
    assert.deepEqual(records.map(({ country, hostname, outcome, rejectionReasons, stage }) => ({ country, hostname, outcome, rejectionReasons, ...(stage ? { stage } : {}) })), [
      { country: 'Japan', hostname: 'outside.example.edu', outcome: 'rejected', rejectionReasons: ['exact_host'] },
      { country: 'South Korea', hostname: 'cs.kaist.ac.kr', outcome: 'rejected', rejectionReasons: ['no_named_professor_identity'], stage: 'professor_evidence' },
      { country: 'Japan', hostname: 'www.kurims.kyoto-u.ac.jp', outcome: 'rejected', rejectionReasons: ['no_official_research_evidence'], stage: 'professor_evidence' },
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

test('pilot diagnostics record targeting mode without retaining query content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gradreach-targeting-diagnostic-'));
  const path = join(directory, 'result-diagnostics.jsonl');
  try {
    await appendPhase3ResultDiagnostic({
      stage: 'brave_search', country: 'Estonia', hostname: null, outcome: 'search_started',
      rejectionReasons: [], targetingMode: 'query_and_host',
    }, path);
    const output = await readFile(path, 'utf8');
    const record = JSON.parse(output) as Record<string, unknown>;
    assert.equal(record.targetingMode, 'query_and_host');
    assert.equal(Object.hasOwn(record, 'query'), false);
    await assert.rejects(appendPhase3ResultDiagnostic({
      stage: 'brave_search', country: 'Estonia', hostname: null, outcome: 'search_started', rejectionReasons: [],
    }, path), /Invalid result diagnostic/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test('Brave search failures retain stage and safe HTTP details without raw messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gradreach-brave-diagnostic-'));
  const path = join(directory, 'result-diagnostics.jsonl');
  try {
    await appendPhase3ResultDiagnostic({
      stage: 'brave_search', country: 'South Korea', hostname: null, outcome: 'search_failed',
      rejectionReasons: ['rate_limited'], statusCode: 429, errorName: 'FetchError',
      errorCode: 'private-token', causeName: 'TypeError', causeCode: 'ECONNRESET',
      braveErrorCode: 'QUERY_VALIDATION', requestId: 'req-123',
    }, path);
    await appendPhase3ResultDiagnostic({
      stage: 'brave_search', country: 'Japan', hostname: null, outcome: 'search_failed',
      rejectionReasons: ['http_status'], statusCode: 422,
      braveErrorCode: 'query contains private value', requestId: 'invalid/id',
    }, path);

    const output = await readFile(path, 'utf8');
    const records = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    const [record, unsafeRecord] = records;
    assert.ok(record);
    assert.deepEqual({ stage: record.stage, country: record.country, outcome: record.outcome,
      rejectionReasons: record.rejectionReasons, statusCode: record.statusCode, errorName: record.errorName,
      causeName: record.causeName, causeCode: record.causeCode, braveErrorCode: record.braveErrorCode,
      requestId: record.requestId }, {
      stage: 'brave_search', country: 'South Korea', outcome: 'search_failed',
      rejectionReasons: ['rate_limited'], statusCode: 429, errorName: 'FetchError',
      causeName: 'TypeError', causeCode: 'ECONNRESET', braveErrorCode: 'QUERY_VALIDATION', requestId: 'req-123',
    });
    assert.ok(unsafeRecord);
    assert.equal(unsafeRecord.braveErrorCode, undefined);
    assert.equal(unsafeRecord.requestId, undefined);
    assert.equal(output.includes('query contains private value'), false);
    assert.equal(output.includes('invalid/id'), false);
    assert.equal(output.includes('private-token'), false);
    assert.equal(output.includes('message'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('followed redirect diagnostics retain only status, host, and sanitized destination path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gradreach-redirect-diagnostic-'));
  const path = join(directory, 'result-diagnostics.jsonl');
  try {
    await appendPhase3ResultDiagnostic({
      stage: 'official_page_fetch', country: 'Denmark', hostname: 'orbit.dtu.dk', outcome: 'redirect_followed',
      rejectionReasons: [], statusCode: 301, redirectDestinationHost: 'faculty.dtu.dk',
      redirectDestinationPath: '/profile/person?token=private',
    }, path);
    const output = await readFile(path, 'utf8');
    const record = JSON.parse(output) as Record<string, unknown>;
    assert.equal(record.statusCode, 301);
    assert.equal(record.redirectDestinationHost, 'faculty.dtu.dk');
    assert.equal(record.redirectDestinationPath, '/profile/person');
    assert.equal(output.includes('token=private'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
