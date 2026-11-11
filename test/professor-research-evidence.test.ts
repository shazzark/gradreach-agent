import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { prepareFetchedProfessorEvidence, prepareSavedProfessorEvidence, matchingResearchInterests, persistPreparedProfessorEvidence } from '../src/application/professor-research-evidence.ts';
import { OFFICIAL_HOSTS_BY_REGION, OFFICIAL_INSTITUTION_BY_REGION } from '../src/config/official-host-allowlist.ts';

test('each verified official-host region has an institution identity for affiliation checks', () => {
  assert.deepEqual(Object.keys(OFFICIAL_INSTITUTION_BY_REGION).sort(), Object.keys(OFFICIAL_HOSTS_BY_REGION).sort());
});

const url = 'https://www.kurims.kyoto-u.ac.jp/en/people/jane-doe';
const research = 'Jane Doe researches distributed systems that preserve service availability during regional network failures.';

function candidate(overrides: Partial<ProfessorCandidate> = {}): ProfessorCandidate {
  return {
    id: 'jane-doe', name: 'Jane Doe', professorName: 'Jane Doe', institution: '', country: '', searchRegion: 'Japan',
    leadType: 'professor_profile', officialProfileUrl: url, status: 'needs-evidence', approvedForSending: false, priority: 0,
    ...overrides,
  };
}

test('official profile inspection packages its exact professor identity and substantive research quote', () => {
  const page = `<h1>Professor Jane Doe</h1><p>Professor of Computer Science.</p><p>${research}</p>`;
  const prepared = prepareFetchedProfessorEvidence({ candidate: candidate(), sourceUrl: url, html: page,
    researchInterests: ['distributed systems', 'privacy'], checkedAt: '2026-11-04T10:00:00.000Z' });
  assert.equal(prepared.professorName, 'Jane Doe');
  assert.equal(prepared.identityQuote, 'Professor Jane Doe');
  assert.equal(prepared.researchQuote, research);
  assert.equal(prepared.sourceUrl, url);
  assert.equal(prepared.affiliation.status, 'verified');
  assert.equal(prepared.affiliation.institution, 'Kyoto University');
  assert.deepEqual(prepared.matchedInterests, ['distributed systems']);
  assert.equal(prepared.recommendation, 'likely relevant');
  assert.equal(prepared.uncertaintyReasons.length, 0);
});

test('quote from another page cannot complete an evidence package', () => {
  const lead = candidate({ discoveryEvidence: [{ kind: 'professor-profile', sourceUrl: 'https://www.kurims.kyoto-u.ac.jp/other', excerpt: research, quote: research, retrievedAt: '2026-11-01T00:00:00Z', verification: 'unverified', region: 'Japan', query: 'fixture' }] });
  const prepared = prepareFetchedProfessorEvidence({ candidate: lead, sourceUrl: url, html: '<h1>Jane Doe</h1><p>Welcome to the faculty page.</p>', researchInterests: ['distributed systems'], checkedAt: '2026-11-04T10:00:00.000Z' });
  assert.equal(prepared.recommendation, 'uncertain');
  assert.equal(prepared.researchQuote, undefined);
  assert.ok(prepared.uncertaintyReasons.some((reason) => reason.includes('exact allowlisted official university page')));
});

test('changed identity remains uncertain even when the official institution host is valid', () => {
  const prepared = prepareFetchedProfessorEvidence({ candidate: candidate(), sourceUrl: url,
    html: `<h1>Professor Janie Doe</h1><p>Professor of Computer Science.</p><p>${research.replaceAll('Jane Doe', 'Janie Doe')}</p>`, researchInterests: ['distributed systems'], checkedAt: '2026-11-04T10:00:00.000Z' });
  assert.equal(prepared.affiliation.status, 'verified');
  assert.equal(prepared.recommendation, 'uncertain');
  assert.ok(prepared.uncertaintyReasons.some((reason) => reason.includes('saved professor identity')));
});

test('complete official evidence with no saved-interest match is an advisory unlikely recommendation', () => {
  const prepared = prepareFetchedProfessorEvidence({ candidate: candidate(), sourceUrl: url,
    html: `<h1>Jane Doe</h1><p>Associate Professor.</p><p>${research}</p>`, researchInterests: ['computational linguistics'], checkedAt: '2026-11-04T10:00:00.000Z' });
  assert.equal(prepared.recommendation, 'unlikely');
  assert.deepEqual(prepared.matchedInterests, []);
});

test('one verified match out of four saved interests qualifies while no matches do not', () => {
  const interests = ['distributed systems', 'robotics', 'computer vision', 'cryptography'];
  const oneMatch = prepareFetchedProfessorEvidence({ candidate: candidate(), sourceUrl: url,
    html: `<h1>Jane Doe</h1><p>Associate Professor.</p><p>${research}</p>`, researchInterests: interests, checkedAt: '2026-11-04T10:00:00.000Z' });
  const noMatches = prepareFetchedProfessorEvidence({ candidate: candidate(), sourceUrl: url,
    html: `<h1>Jane Doe</h1><p>Associate Professor.</p><p>${research}</p>`,
    researchInterests: ['genomics', 'digital humanities', 'marine ecology', 'quantum optics'], checkedAt: '2026-11-04T10:00:00.000Z' });

  assert.deepEqual(oneMatch.matchedInterests, ['distributed systems']);
  assert.equal(oneMatch.recommendation, 'likely relevant');
  assert.deepEqual(noMatches.matchedInterests, []);
  assert.equal(noMatches.recommendation, 'unlikely');
});

test('one matching interest out of the six saved topics qualifies without requiring all six', () => {
  const interests = [
    'Cybersecurity, privacy, and network security', 'AI and machine learning',
    'Software engineering, cloud, and distributed systems',
    'Robotics and autonomous systems, including intelligent robotics and robot perception',
    'Database systems and data-intensive applications',
    'Mobile computing and human-computer interaction, including accessibility',
  ];
  const matches = matchingResearchInterests('Research focuses on machine learning methods.', interests);
  assert.deepEqual(matches, ['AI and machine learning']);
  assert.equal(matches.length > 0, true);
  assert.deepEqual(matchingResearchInterests('Research focuses on marine ecology.', interests), []);
});

test('saved profile evidence is reused only when the quote is exact on its own official page', () => {
  const lead = candidate({ discoveryEvidence: [{ kind: 'professor-profile', sourceUrl: url, excerpt: `Jane Doe · ${research}`, quote: research, retrievedAt: '2026-11-04T09:00:00.000Z', verification: 'unverified', region: 'Japan', query: 'fixture' }] });
  const prepared = prepareSavedProfessorEvidence({ candidate: lead, researchInterests: ['distributed systems'], checkedAt: '2026-11-04T10:00:00.000Z' });
  assert.equal(prepared.researchQuote, research);
  assert.equal(prepared.recommendation, 'likely relevant');
  assert.deepEqual(matchingResearchInterests('We study distributed systems.', ['distributed systems', 'privacy']), ['distributed systems']);
});

test('non-allowlisted profile URLs produce an uncertain package without affiliation claims', () => {
  const prepared = prepareFetchedProfessorEvidence({ candidate: candidate(), sourceUrl: 'https://unapproved.example/profile',
    html: `<h1>Jane Doe</h1><p>${research}</p>`, researchInterests: ['distributed systems'], checkedAt: '2026-11-04T10:00:00.000Z' });
  assert.equal(prepared.recommendation, 'uncertain');
  assert.equal(prepared.affiliation.status, 'uncertain');
  assert.ok(prepared.uncertaintyReasons.some((reason) => reason.includes('exact allowlisted HTTPS host')));
});

test('manual evidence packages persist separately and preserve human decisions', async () => {
  const current = candidate({ discoveryEvidence: [{ kind: 'professor-profile', sourceUrl: url, excerpt: `Jane Doe · ${research}`, quote: research, retrievedAt: '2026-11-04T09:00:00.000Z', verification: 'unverified', region: 'Japan', query: 'fixture' }] });
  const reviewed = candidate({ id: 'reviewed', discoveryReview: { decision: 'rejected', reviewedAt: '2026-11-03T10:00:00.000Z' } });
  const ready = candidate({ id: 'ready', status: 'ready-for-review', discoveryEvidence: [{ kind: 'professor-profile', sourceUrl: url, excerpt: `Jane Doe · ${research}`, quote: research, retrievedAt: '2026-11-04T09:00:00.000Z', verification: 'unverified', region: 'Japan', query: 'fixture' }] });
  const approved = candidate({ id: 'approved', status: 'approved', approvedForSending: true, approvedAt: '2026-11-03T10:00:00.000Z' });
  const original = structuredClone([current, reviewed, ready, approved]);
  const saved: Array<{ id: string; evidencePackage: { recommendation: string } }> = [];
  const packages = await persistPreparedProfessorEvidence({
    candidates: [current, reviewed, ready, approved], researchInterests: ['distributed systems'],
    checkedAt: '2026-11-04T10:00:00.000Z', runId: 'manual:2026-11-04',
    repository: { async save(check) { saved.push(check); } },
  });
  assert.equal(packages.length, 2);
  assert.equal(saved.length, 2);
  assert.equal(saved[0]?.id, 'manual:2026-11-04:jane-doe');
  assert.equal(saved[0]?.evidencePackage.recommendation, 'likely relevant');
  assert.deepEqual([current, reviewed, ready, approved], original);
});
