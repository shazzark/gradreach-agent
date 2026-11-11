import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyResearchOutcome, deduplicateResearchTargets, enrichConfirmedProfessorResearch, evaluateResearchInterestMatch,
  isResearchEnrichmentComplete, resumableResearchTargets, sanitizeResearchEvidenceQuote, validatedResearchEnrichmentRow,
  type ConfirmedProfessorResearchResult, type ConfirmedProfessorResearchTarget,
} from '../src/application/confirmed-professor-research-enrichment.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';
import { enrichSavedConfirmedProfessors } from '../src/interfaces/enrich-confirmed-professors.ts';

const profileUrl = `https://${OFFICIAL_HOSTS_BY_REGION.Canada[0]}/people/ada-example`;
const target: ConfirmedProfessorResearchTarget = {
  stableId: 'safe-id-1', name: 'Ada Example', institution: 'Example University', country: 'Canada', officialProfileUrl: profileUrl,
};
const interests = [
  'Cybersecurity, privacy, and network security', 'AI and machine learning',
  'Software engineering, cloud, and distributed systems',
  'Robotics and autonomous systems, including intelligent robotics and robot perception',
  'Database systems and data-intensive applications',
  'Mobile computing and human-computer interaction, including accessibility',
];

function htmlPage(content: string): Response {
  return new Response(content, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

test('one match among the six saved interests passes while no match fails', () => {
  assert.equal(evaluateResearchInterestMatch('Research focuses on machine learning.', interests), true);
  assert.equal(evaluateResearchInterestMatch('Research focuses on marine ecology.', interests), false);
});

test('outcomes distinguish verified match, mismatch, absent evidence, fetch failure, and budget stop', () => {
  const base = { identityEstablished: true, expectedIdentityConfirmed: true, relevantResearchEvidenceEstablished: true, quote: 'specific research', failedFetches: 0, budgetReached: false };
  assert.equal(classifyResearchOutcome({ ...base, matched: true }).outcome, 'matched');
  assert.equal(classifyResearchOutcome({ ...base, matched: false }).outcome, 'evidence_found_no_match');
  const { quote: _quote, ...withoutQuote } = base;
  assert.equal(classifyResearchOutcome({ ...withoutQuote, relevantResearchEvidenceEstablished: false, matched: false }).outcome, 'no_research_evidence');
  assert.equal(classifyResearchOutcome({ ...base, matched: false, failedFetches: 1 }).outcome, 'fetch_failed');
  assert.equal(classifyResearchOutcome({ ...base, matched: false, budgetReached: true }).outcome, 'not_evaluated');
});

test('target deduplication uses canonical official profile and normalized person/institution identity', () => {
  const result = deduplicateResearchTargets([
    target,
    { ...target, stableId: 'duplicate-url', officialProfileUrl: `${profileUrl}?utm_source=fixture#bio` },
    { ...target, stableId: 'duplicate-person', officialProfileUrl: `https://${OFFICIAL_HOSTS_BY_REGION.Canada[0]}/people/ada-other`, name: ' ADA   EXAMPLE ' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.officialProfileUrl, profileUrl);
});

test('resumability skips completed outcomes and leaves failures or budget stops available', () => {
  const result = (outcome: ConfirmedProfessorResearchResult['outcome'], id: string): ConfirmedProfessorResearchResult => ({
    ...target, stableId: id, outcome, reasonCode: outcome === 'matched' ? 'interest_match' : outcome === 'fetch_failed' ? 'fetch_failed' : 'fetch_budget_reached',
    interestMatch: outcome === 'matched' ? 'matched' : 'not_evaluated', explanation: 'safe explanation', failureCodes: [],
    traversal: { directoryFetched: false, profileLinksConsidered: 0, profileLinksSelected: 0, profileLinksFetched: 0, identityEstablished: false, researchLinksConsidered: 0, researchLinksSelected: 0, researchLinksFetched: 0, relevantResearchEvidenceEstablished: false, pageFetches: 0, httpStatuses: [], contentTypes: [] }, checkedAt: '2026-11-09T00:00:00.000Z',
  });
  const targets = ['done', 'failed', 'budget', 'pending'].map((stableId) => ({ ...target, stableId }));
  const saved = [result('matched', 'done'), result('fetch_failed', 'failed'), result('not_evaluated', 'budget')];
  assert.deepEqual(resumableResearchTargets(targets, saved).map((item) => item.stableId), ['failed', 'budget', 'pending']);
  assert.equal(isResearchEnrichmentComplete(saved[0]), true);
  assert.equal(isResearchEnrichmentComplete(saved[1]), false);
});

test('official profile evidence produces a bounded match and preserves HTTP/content diagnostics only', async () => {
  const result = await enrichConfirmedProfessorResearch({
    target, interests, checkedAt: '2026-11-09T00:00:00.000Z', pageFetchBudget: { remaining: 30 },
    fetchImpl: async () => htmlPage('<h1>Dr Ada Example</h1><p>Associate Professor of Computer Science.</p><p>Dr Ada Example researches machine learning methods for reliable systems.</p>'),
  });
  assert.equal(result.outcome, 'matched');
  assert.equal(result.interestMatch, 'matched');
  assert.equal(result.traversal.identityEstablished, true);
  assert.equal(result.traversal.pageFetches, 1);
  assert.deepEqual(result.traversal.httpStatuses, [200]);
  assert.deepEqual(result.traversal.contentTypes, ['text/html']);
  assert.match(result.researchEvidence?.quote ?? '', /machine learning/i);
});

test('fetch failure is not mislabeled as no-match or no-evidence', async () => {
  const result = await enrichConfirmedProfessorResearch({
    target, interests, checkedAt: '2026-11-09T00:00:00.000Z', pageFetchBudget: { remaining: 30 },
    fetchImpl: async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
  });
  assert.equal(result.outcome, 'fetch_failed');
  assert.equal(result.interestMatch, 'not_evaluated');
  assert.deepEqual(result.traversal.httpStatuses, [503]);
});

test('research from a differently named official profile is not attributed to the saved professor', async () => {
  const result = await enrichConfirmedProfessorResearch({
    target, interests, checkedAt: '2026-11-09T00:00:00.000Z', pageFetchBudget: { remaining: 30 },
    fetchImpl: async () => htmlPage('<h1>Dr Bea Example</h1><p>Associate Professor of Computer Science.</p><p>Dr Bea Example researches machine learning methods.</p>'),
  });
  assert.equal(result.outcome, 'not_evaluated');
  assert.equal(result.reasonCode, 'identity_not_reconfirmed');
  assert.equal(result.interestMatch, 'not_evaluated');
  assert.equal(result.researchEvidence, undefined);
});

test('a project explicitly led by another investigator is not attributed to this professor', async () => {
  const result = await enrichConfirmedProfessorResearch({
    target, interests, checkedAt: '2026-11-09T00:00:00.000Z', pageFetchBudget: { remaining: 30 },
    fetchImpl: async () => htmlPage('<h1>Dr Ada Example</h1><p>Associate Professor of Computer Science.</p><p>This project was led by Dr Bea Example and studies machine learning.</p>'),
  });
  assert.equal(result.outcome, 'no_research_evidence');
  assert.equal(result.interestMatch, 'not_evaluated');
  assert.equal(result.researchEvidence, undefined);
});

test('a fully inspected identity profile without research evidence is distinct from a budget stop', async () => {
  const emptyResearch = await enrichConfirmedProfessorResearch({
    target, interests, checkedAt: '2026-11-09T00:00:00.000Z', pageFetchBudget: { remaining: 30 },
    fetchImpl: async () => htmlPage('<h1>Dr Ada Example</h1><p>Associate Professor of Computer Science.</p><p>Welcome to the department.</p>'),
  });
  assert.equal(emptyResearch.outcome, 'no_research_evidence');
  assert.equal(emptyResearch.interestMatch, 'not_evaluated');

  const stopped = await enrichConfirmedProfessorResearch({
    target, interests, checkedAt: '2026-11-09T00:00:00.000Z', pageFetchBudget: { remaining: 0 },
    fetchImpl: async () => { throw new Error('must not fetch after budget'); },
  });
  assert.equal(stopped.outcome, 'not_evaluated');
  assert.equal(stopped.reasonCode, 'fetch_budget_reached');
});

test('completed professors are resumably skipped without another page fetch', async () => {
  const saved = await enrichConfirmedProfessorResearch({
    target, interests, checkedAt: '2026-11-09T00:00:00.000Z', pageFetchBudget: { remaining: 30 },
    fetchImpl: async () => htmlPage('<h1>Dr Ada Example</h1><p>Associate Professor of Computer Science.</p><p>Dr Ada Example researches machine learning methods.</p>'),
  });
  let fetched = false;
  const report = await enrichSavedConfirmedProfessors({
    targets: [target], interests, previous: { schemaVersion: 1, generatedAt: saved.checkedAt, totalProfessors: 1, completedProfessors: 1, professors: [saved] },
    now: () => new Date('2026-11-09T00:01:00.000Z'), fetchImpl: async () => { fetched = true; throw new Error('unexpected repeat fetch'); },
  });
  assert.equal(fetched, false);
  assert.equal(report.completedProfessors, 1);
  assert.equal(report.professors[0]?.outcome, 'matched');
});

test('evidence sanitization strips embedded links and contact details and validates official source hosts', () => {
  const quote = sanitizeResearchEvidenceQuote('AI research. Contact person@example.edu at https://private.example/path?q=secret');
  assert.equal(quote, 'AI research. Contact [email omitted] at [link omitted]');
  const row = {
    ...target, outcome: 'matched', reasonCode: 'interest_match', interestMatch: 'matched', explanation: 'Matched one saved interest.',
    researchEvidence: { quote, sourceUrl: profileUrl }, failureCodes: [], checkedAt: '2026-11-09T00:00:00.000Z',
    traversal: { httpStatuses: [200], contentTypes: ['text/html'], pageFetches: 1 },
  };
  const validated = validatedResearchEnrichmentRow(row, target);
  assert.equal(validated?.researchEvidence?.quote, quote);
  assert.equal(validated?.researchEvidence?.sourceUrl, profileUrl);
  assert.equal(validatedResearchEnrichmentRow({ ...row, researchEvidence: { quote, sourceUrl: 'https://outside.example/profile' } }, target)?.researchEvidence, undefined);
  const serialized = JSON.stringify(validated);
  assert.doesNotMatch(serialized, /person@example\.edu|private\.example|q=secret|Cybersecurity|AI and machine learning|search query/);
});
