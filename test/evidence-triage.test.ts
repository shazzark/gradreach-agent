import test from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateEvidenceTriage, DiscoveryEvidence, ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { triageCandidateEvidence } from '../src/application/evidence-triage.ts';

const sourceUrl = 'https://cs.kaist.ac.kr/research';
const identityQuote = 'Private Name leads the Secure Systems Lab at KAIST.';
const researchQuote = 'The lab researches network security and machine learning for resilient systems.';
const relevantInterests = ['network security', 'machine learning'];

function makeCandidate(overrides: Partial<ProfessorCandidate> = {}, evidence?: DiscoveryEvidence[]): ProfessorCandidate {
  return {
    id: 'candidate-hash-1', name: 'Private Name | Secure Systems Lab', institution: 'KAIST', country: 'South Korea',
    officialProfileUrl: sourceUrl,
    officialEmail: 'private@example.edu', officialContactUrl: 'https://cs.kaist.ac.kr/contact',
    discoveryEvidence: evidence ?? [
      { kind: 'professor-profile', sourceUrl: `${sourceUrl}?session=private#profile`, excerpt: `${identityQuote} ${researchQuote} Contact: professor@example.edu Tel: +1 555 123 4567.`, retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'secret applicant query' },
      { kind: 'contact', sourceUrl: 'https://cs.kaist.ac.kr/contact', excerpt: 'Contact professor@example.edu', retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'private contact query' },
      { kind: 'search-result', sourceUrl: 'https://directory.example/search', excerpt: 'Third-party search text', retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'private search query' },
    ],
    status: 'needs-evidence', approvedForSending: false, priority: 0,
    ...overrides,
  };
}

function response(recommendation: string, facts: unknown[] = [
  { kind: 'identity', sourceUrl, quote: identityQuote },
  { kind: 'research', sourceUrl, quote: researchQuote },
]): unknown {
  return { recommendations: [{ leadNumber: 1, recommendation, facts }] };
}

function repository(saved: CandidateEvidenceTriage[]) {
  return { async save(item: CandidateEvidenceTriage) { saved.push(structuredClone(item)); } };
}

const allowlist = { 'South Korea': ['cs.kaist.ac.kr'] };

test('substantive professor identity and relevant research support a likely label and concise rationale', async () => {
  const candidate = makeCandidate();
  const before = JSON.stringify(candidate);
  const saved: CandidateEvidenceTriage[] = [];
  let providerPayload = '';
  const results = await triageCandidateEvidence({
    candidates: [candidate], researchCriteria: relevantInterests, officialHostsByRegion: allowlist,
    provider: { async triageEvidence(input) { providerPayload = JSON.stringify(input); return response('likely relevant'); } },
    repository: repository(saved), now: () => new Date('2026-10-30T12:00:00.000Z'),
  });
  assert.equal(results[0]?.recommendation, 'likely relevant');
  assert.equal(results[0]?.rationale, 'The official profile identifies Private Name and describes research matching the configured interests.');
  assert.deepEqual(results[0]?.facts, [
    { kind: 'identity', sourceUrl, quote: identityQuote },
    { kind: 'research', sourceUrl, quote: researchQuote },
  ]);
  assert.deepEqual(saved, results);
  assert.equal(JSON.stringify(candidate), before);
  assert.equal(candidate.status, 'needs-evidence');
  assert.equal(candidate.approvedForSending, false);
  for (const privateValue of ['candidate-hash-1', 'private@example.edu', 'professor@example.edu', '555 123 4567', 'secret applicant query', 'private contact query', 'Third-party search text']) {
    assert.equal(providerPayload.includes(privateValue), false);
  }
  assert.match(providerPayload, /network security/);
  assert.match(providerPayload, /machine learning/);
  assert.match(providerPayload, /Private Name/);
  assert.equal(providerPayload.includes('?session=private'), false);
});

test('a named professor page title without substantive research text stays uncertain', async () => {
  const title = 'Private Name — Network Security Research Lab';
  const candidate = makeCandidate({
    name: title,
    institution: 'University of Auckland',
    country: 'New Zealand',
    officialProfileUrl: 'https://www.auckland.ac.nz/research',
    discoveryEvidence: [{ kind: 'professor-profile', sourceUrl: 'https://www.auckland.ac.nz/research', excerpt: title, retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'New Zealand', query: 'not sent' }],
  });
  const saved: CandidateEvidenceTriage[] = [];
  let providerCalls = 0;
  const results = await triageCandidateEvidence({
    candidates: [candidate], researchCriteria: ['cybersecurity'], officialHostsByRegion: { 'New Zealand': ['www.auckland.ac.nz'] },
    provider: { async triageEvidence() { providerCalls += 1; return {}; } }, repository: repository(saved),
  });
  assert.equal(providerCalls, 0);
  assert.equal(results[0]?.recommendation, 'uncertain');
  assert.match(results[0]?.rationale ?? '', /does not establish the professor identity and research details together/);
  assert.deepEqual(results[0]?.facts, [{ kind: 'context', sourceUrl: 'https://www.auckland.ac.nz/research', quote: title }]);
});

test('generic school descriptions do not become professor leads', async () => {
  const excerpt = 'The School of Computing supports a broad range of academic research activities.';
  const candidate = makeCandidate({
    name: 'School of Computing – Example University',
    discoveryEvidence: [{ kind: 'official-page', sourceUrl: 'https://cs.kaist.ac.kr/school', excerpt, retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'not sent' }],
  });
  delete candidate.officialProfileUrl;
  const saved: CandidateEvidenceTriage[] = [];
  let providerCalls = 0;
  const results = await triageCandidateEvidence({
    candidates: [candidate], researchCriteria: relevantInterests, officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { providerCalls += 1; return {}; } }, repository: repository(saved),
  });
  assert.equal(providerCalls, 0);
  assert.equal(results[0]?.recommendation, 'uncertain');
  assert.match(results[0]?.rationale ?? '', /general school or program source/);
  assert.deepEqual(results[0]?.facts, [{ kind: 'context', sourceUrl: 'https://cs.kaist.ac.kr/school', quote: excerpt }]);
});

test('missing official excerpts remain unknown with an empty quote list', async () => {
  const candidate = makeCandidate({ discoveryEvidence: [
    { kind: 'professor-profile', sourceUrl, excerpt: '', retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'do not send' },
    { kind: 'search-result', sourceUrl: 'https://cs.kaist.ac.kr/search', excerpt: 'Search text is not official-page evidence.', retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'do not send' },
  ] });
  const saved: CandidateEvidenceTriage[] = [];
  let providerCalls = 0;
  const results = await triageCandidateEvidence({
    candidates: [candidate], researchCriteria: relevantInterests, officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { providerCalls += 1; return {}; } }, repository: repository(saved),
  });
  assert.equal(providerCalls, 0);
  assert.equal(results[0]?.recommendation, 'uncertain');
  assert.match(results[0]?.rationale ?? '', /excerpt is available/);
  assert.deepEqual(results[0]?.facts, []);
});

test('an exact but irrelevant research quote cannot support likely relevant', async () => {
  const irrelevantQuote = 'The lab researches marine sediment and coastal geology in the Ocean Group.';
  const candidate = makeCandidate({ discoveryEvidence: [{
    kind: 'professor-profile', sourceUrl, excerpt: `${identityQuote} ${irrelevantQuote}`, retrievedAt: '2026-10-30T00:00:00.000Z', verification: 'unverified', region: 'South Korea', query: 'not sent',
  }] });
  const saved: CandidateEvidenceTriage[] = [];
  const results = await triageCandidateEvidence({
    candidates: [candidate], researchCriteria: relevantInterests, officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { return response('likely relevant', [
      { kind: 'identity', sourceUrl, quote: identityQuote },
      { kind: 'research', sourceUrl, quote: irrelevantQuote },
    ]); } }, repository: repository(saved),
  });
  assert.equal(results[0]?.recommendation, 'uncertain');
  assert.match(results[0]?.rationale ?? '', /does not establish a match/);
  assert.equal(results[0]?.facts[1]?.quote, irrelevantQuote);
  assert.deepEqual(saved, results);
});

test('invented or mismatched exact quotes are rejected without storing recommendations', async () => {
  const saved: CandidateEvidenceTriage[] = [];
  await assert.rejects(triageCandidateEvidence({
    candidates: [makeCandidate()], researchCriteria: relevantInterests, officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { return response('likely relevant', [
      { kind: 'identity', sourceUrl, quote: identityQuote },
      { kind: 'research', sourceUrl, quote: 'Invented cybersecurity research claim.' },
    ]); } }, repository: repository(saved),
  }), /exact quote did not match/);
  await assert.rejects(triageCandidateEvidence({
    candidates: [makeCandidate()], researchCriteria: relevantInterests, officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { return response('likely relevant', [
      { kind: 'identity', sourceUrl: 'https://directory.example/profile', quote: identityQuote },
      { kind: 'research', sourceUrl, quote: researchQuote },
    ]); } }, repository: repository(saved),
  }), /exact quote did not match/);
  assert.equal(saved.length, 0);
});

test('malformed model responses and provider failure never save triage', async () => {
  const saved: CandidateEvidenceTriage[] = [];
  await assert.rejects(triageCandidateEvidence({
    candidates: [makeCandidate()], researchCriteria: relevantInterests, officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { return { recommendations: [{ leadNumber: 1, recommendation: 'maybe', facts: [] }] }; } }, repository: repository(saved),
  }), /invalid structure/);
  await assert.rejects(triageCandidateEvidence({
    candidates: [makeCandidate()], researchCriteria: relevantInterests, officialHostsByRegion: allowlist,
    provider: { async triageEvidence() { throw new Error('Gemini unavailable'); } }, repository: repository(saved),
  }), /Gemini unavailable/);
  assert.equal(saved.length, 0);
});
