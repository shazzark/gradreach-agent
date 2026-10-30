import test from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateEvidenceTriage, DiscoveryEvidence, ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { triageCandidateEvidence } from '../src/application/evidence-triage.ts';

const sourceUrl = 'https://cs.kaist.ac.kr/research';
const supportedQuote = 'Our group researches network security and machine learning.';

function makeCandidate(evidence: DiscoveryEvidence[] = [
  { kind: 'official-page', sourceUrl: `${sourceUrl}?session=private#research`, excerpt: `${supportedQuote} Contact: professor@example.edu Tel: +1 555 123 4567.`, retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'secret applicant query' },
  { kind: 'contact', sourceUrl: 'https://cs.kaist.ac.kr/contact', excerpt: 'Contact professor@example.edu', retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'private contact query' },
  { kind: 'search-result', sourceUrl: 'https://directory.example/search', excerpt: 'Third-party search text', retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'private search query' },
]): ProfessorCandidate {
  return {
    id: 'candidate-hash-1', name: 'Professor Private Name', institution: 'KAIST', country: 'South Korea',
    officialEmail: 'private@example.edu', officialContactUrl: 'https://cs.kaist.ac.kr/contact',
    discoveryEvidence: evidence, status: 'needs-evidence', approvedForSending: false, priority: 0,
  };
}

function triageResponse(recommendation: string, facts: unknown[] = [{ sourceUrl, quote: supportedQuote }]): unknown {
  return { recommendations: [{ leadNumber: 1, recommendation, facts }] };
}

function repository(saved: CandidateEvidenceTriage[]) {
  return { async save(item: CandidateEvidenceTriage) { saved.push(structuredClone(item)); } };
}

const allowlist = { 'South Korea': ['cs.kaist.ac.kr'] };

test('valid triage stores only exact cited evidence separately from the candidate', async () => {
  const candidate = makeCandidate();
  const before = JSON.stringify(candidate);
  const saved: CandidateEvidenceTriage[] = [];
  let providerPayload = '';
  const results = await triageCandidateEvidence({
    candidates: [candidate],
    researchCriteria: ['network security', 'machine learning'],
    officialHostsByRegion: allowlist,
    provider: {
      async triageEvidence(input) {
        providerPayload = JSON.stringify(input);
        return triageResponse('likely relevant');
      },
    },
    repository: repository(saved),
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  });
  assert.deepEqual(results, [{
    candidateId: 'candidate-hash-1', recommendation: 'likely relevant',
    facts: [{ sourceUrl, quote: supportedQuote }], triagedAt: '2026-10-30T12:00:00.000Z',
  }]);
  assert.deepEqual(saved, results);
  assert.equal(JSON.stringify(candidate), before);
  for (const privateValue of ['candidate-hash-1', 'Professor Private Name', 'private@example.edu', 'professor@example.edu', '555 123 4567', 'secret applicant query', 'private contact query', 'Third-party search text']) {
    assert.equal(providerPayload.includes(privateValue), false);
  }
  assert.match(providerPayload, /network security/);
  assert.match(providerPayload, /machine learning/);
  assert.match(providerPayload, /"leadNumber":1/);
  assert.equal(providerPayload.includes('?session=private'), false);
});

test('invented quotes are rejected without storing a recommendation', async () => {
  const saved: CandidateEvidenceTriage[] = [];
  await assert.rejects(triageCandidateEvidence({
    candidates: [makeCandidate()], researchCriteria: ['network security'], officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { return triageResponse('likely relevant', [{ sourceUrl, quote: 'Invented cybersecurity leadership.' }]); } },
    repository: repository(saved),
  }), /exact quote did not match/);
  assert.equal(saved.length, 0);
});

test('quotes attributed to a mismatched or non-allowlisted source are rejected', async () => {
  const saved: CandidateEvidenceTriage[] = [];
  await assert.rejects(triageCandidateEvidence({
    candidates: [makeCandidate()], researchCriteria: ['network security'], officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { return triageResponse('likely relevant', [{ sourceUrl: 'https://directory.example/research', quote: supportedQuote }]); } },
    repository: repository(saved),
  }), /exact quote did not match/);
  assert.equal(saved.length, 0);
});

test('missing or disallowed official evidence stays unknown without a provider call', async () => {
  const candidate = makeCandidate([
    { kind: 'search-result', sourceUrl: 'https://cs.kaist.ac.kr/search', excerpt: 'Search text is not official-page evidence.', retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'do not send' },
    { kind: 'official-page', sourceUrl: 'https://outside.example/research', excerpt: 'Host is not allowlisted.', retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'do not send' },
  ]);
  const saved: CandidateEvidenceTriage[] = [];
  let providerCalls = 0;
  const results = await triageCandidateEvidence({
    candidates: [candidate], researchCriteria: ['cybersecurity'], officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { providerCalls += 1; return {}; } }, repository: repository(saved),
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual(results[0]?.recommendation, 'uncertain');
  assert.deepEqual(results[0]?.facts, []);
  assert.deepEqual(saved, results);
});

test('malformed or incomplete model responses are rejected atomically', async () => {
  const saved: CandidateEvidenceTriage[] = [];
  await assert.rejects(triageCandidateEvidence({
    candidates: [makeCandidate()], researchCriteria: ['network security'], officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { return { recommendations: [{ leadNumber: 1, recommendation: 'maybe', facts: [] }] }; } },
    repository: repository(saved),
  }), /invalid structure/);
  assert.equal(saved.length, 0);
});

test('provider failure leaves the separate recommendation repository untouched', async () => {
  const saved: CandidateEvidenceTriage[] = [];
  await assert.rejects(triageCandidateEvidence({
    candidates: [makeCandidate()], researchCriteria: ['network security'], officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { throw new Error('Gemini unavailable'); } }, repository: repository(saved),
  }), /Gemini unavailable/);
  assert.equal(saved.length, 0);
});
