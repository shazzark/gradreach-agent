import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { extractProfessorIdentityEvidence, extractResearchQuote } from '../src/application/research-discovery.ts';
import { matchingResearchInterests, prepareSavedProfessorEvidence, researchQuoteNamesOtherLead } from '../src/application/professor-research-evidence.ts';
import { reevaluateSavedPreviewEvidence } from '../src/application/replay-preview-evidence.ts';
import { replaySavedPreviewCandidates } from '../src/interfaces/diagnose-saved-preview-candidates.ts';

const profile = parseApplicantProfile({
  applicant: {
    fullName: '', email: '', phone: '', nationality: '', currentLocation: '',
    degree: { title: '', institution: '', country: '', graduationYear: null, classification: '', gpa: null, gpaScale: null, gradingScaleDocument: '' },
    target: { degreeLevel: 'masters', intake: '2027', fields: ['Computer Science'], researchInterests: ['Distributed Systems'], countries: ['Canada'], fundingTypes: ['scholarship'], timezone: 'Africa/Lagos' },
    englishEvidence: { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' },
    documents: { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] },
  },
});

const advisingRecord = JSON.parse(await readFile(new URL('./fixtures/canada-preview-advising-record.json', import.meta.url), 'utf8')) as {
  recordId: string; savedPageTitle: string; profileSource: string;
};
const researchRecord = JSON.parse(await readFile(new URL('./fixtures/canada-preview-research-extraction.json', import.meta.url), 'utf8')) as {
  recordId: string; profileSource: string; excerpt: string;
};
const attributionRecord = JSON.parse(await readFile(new URL('./fixtures/canada-preview-candidate-01-attribution.json', import.meta.url), 'utf8')) as {
  recordId: string; professorName: string; profileSource: string; researchSource: string; identityExcerpt: string; researchExcerpt: string;
};

test('the saved advising-page title cannot establish an individual professor identity', () => {
  const page = `<h1>${advisingRecord.savedPageTitle}</h1><p>Academic advising provides guidance for students and programs.</p>`;
  assert.equal(extractProfessorIdentityEvidence(page), undefined);
  assert.equal(extractProfessorIdentityEvidence('<h1>Quick facts</h1><p>The school has professorial and teaching stream faculty members.</p>'), undefined);
});

test('extracts the captured research-spans sentence while leaving saved-interest matching separate', () => {
  const longPage = `<h1>Profile</h1><p>${'University profile navigation. '.repeat(60)}</p><p>${researchRecord.excerpt}</p>`;
  const quote = extractResearchQuote(longPage);
  assert.equal(quote, researchRecord.excerpt);
  assert.deepEqual(matchingResearchInterests(quote ?? '', ['distributed systems', 'computer science']), []);
  assert.deepEqual(matchingResearchInterests(quote ?? '', ['AI and machine learning']), ['AI and machine learning']);
  assert.deepEqual(matchingResearchInterests(quote ?? '', ['AI and quantum cryptography']), []);
});

test('a departmental project led by another investigator is not attributed to candidate-01', () => {
  assert.equal(researchQuoteNamesOtherLead(attributionRecord.researchExcerpt, attributionRecord.professorName), true);
  assert.equal(researchQuoteNamesOtherLead(attributionRecord.researchExcerpt, 'Guang Gong'), false);
  const candidate: ProfessorCandidate = {
    id: attributionRecord.recordId,
    name: attributionRecord.professorName,
    professorName: attributionRecord.professorName,
    institution: 'University of Waterloo',
    country: 'Canada',
    searchRegion: 'Canada',
    officialProfileUrl: attributionRecord.profileSource,
    discoveryEvidence: [
      { kind: 'professor-profile', sourceUrl: attributionRecord.profileSource, excerpt: attributionRecord.identityExcerpt, quote: attributionRecord.identityExcerpt, retrievedAt: '2026-11-09T00:00:00.000Z', verification: 'unverified', region: 'Canada', query: '' },
      { kind: 'research', sourceUrl: attributionRecord.researchSource, excerpt: attributionRecord.researchExcerpt, quote: attributionRecord.researchExcerpt, retrievedAt: '2026-11-09T00:00:00.000Z', verification: 'unverified', region: 'Canada', query: '' },
    ],
    status: 'needs-evidence', approvedForSending: false, priority: 0,
  };
  const evidence = prepareSavedProfessorEvidence({ candidate, researchInterests: ['cryptographic methods'], checkedAt: '2026-11-09T00:00:00.000Z' });
  assert.equal(evidence.recommendation, 'uncertain');
  assert.equal(evidence.researchQuote, undefined);
  assert.ok(evidence.uncertaintyReasons.includes('The research project names a different lead investigator.'));
});

test('offline reevaluation matches the recorded machine-learning concept without exposing interest values', () => {
  const candidate = reevaluateSavedPreviewEvidence({
    recordId: researchRecord.recordId,
    identity: { established: true, sourceUrl: researchRecord.profileSource, supportingExcerpt: 'Elliot Creager — Assistant Professor' },
    research: { extractedSourceUrl: researchRecord.profileSource, supportingExcerpt: researchRecord.excerpt },
  }, ['AI and machine learning']);
  assert.equal(candidate.researchGate, 'matched');
  assert.equal(candidate.matchedInterestCount, 1);
  assert.equal(candidate.outcome, 'research_gate_passed_remaining_checks_not_replayed');
  assert.equal(JSON.stringify(candidate).includes('AI and machine learning'), false);
});

test('offline reevaluation rejects a report record whose identity gate failed', () => {
  const candidate = reevaluateSavedPreviewEvidence({
    recordId: advisingRecord.recordId,
    identity: { established: false, sourceUrl: advisingRecord.profileSource, supportingExcerpt: advisingRecord.savedPageTitle },
    research: {},
  }, ['AI and machine learning']);
  assert.equal(candidate.researchGate, 'identity_not_established');
  assert.equal(candidate.outcome, 'stopped');
});

test('graduate studies administration is not extracted as a research statement', () => {
  assert.equal(extractResearchQuote('<p>Please submit your graduate studies application and include my name as a potential advisor.</p>'), undefined);
});

test('bounded saved-preview replay distinguishes identity, extraction, and interest-match stages', async () => {
  const researchUrl = 'https://uwaterloo.ca/electrical-computer-engineering/research/example';
  const pageBodies = new Map<string, string>([
    ['https://uwaterloo.ca/electrical-computer-engineering/profile/a2boutro', '<h1>Dr Alex Example</h1><p>Professor of Electrical Engineering.</p><a href="/electrical-computer-engineering/research/example">Research group</a>'],
    [advisingRecord.profileSource, `<h1>${advisingRecord.savedPageTitle}</h1><p>Academic advising provides guidance for students and programs.</p>`],
    ['https://uwaterloo.ca/electrical-computer-engineering/profile/ecreager', '<h1>Dr Sam Example</h1><p>Professor of Computer Science.</p><p>Dr Sam Example researches distributed systems and computer science methods for resilient networked applications.</p>'],
    [researchUrl, '<h1>Research group</h1><p>Research group projects involve resilient computing across several networked applications.</p>'],
  ]);
  const requests: string[] = [];
  const report = await replaySavedPreviewCandidates({
    profile,
    now: () => new Date('2026-11-09T12:00:00.000Z'),
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      const body = pageBodies.get(url);
      return body
        ? new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
        : new Response('missing fixture', { status: 404, headers: { 'content-type': 'text/plain' } });
    },
  });

  assert.deepEqual(requests, [
    'https://uwaterloo.ca/electrical-computer-engineering/profile/a2boutro', researchUrl,
    advisingRecord.profileSource,
    'https://uwaterloo.ca/electrical-computer-engineering/profile/ecreager',
  ], JSON.stringify(report));
  assert.deepEqual(report.candidates.map(({ stopReason }) => stopReason), [
    'no_research_text_extracted', 'identity_not_established', 'passed_all_gates',
  ]);
  assert.equal(report.candidates[0]?.research.linksConsidered.includes(researchUrl), true);
  assert.equal(report.candidates[0]?.research.linksSelected[0]?.sourceUrl, researchUrl);
  assert.equal(report.candidates[0]?.research.linksFetched[0]?.httpStatus, 200);
  assert.equal(report.candidates[0]?.research.linksFetched[0]?.contentType, 'text/html');
  assert.equal(report.candidates[0]?.research.textExtracted, false);
  assert.equal(report.candidates[0]?.research.observedResearchExcerpts[0]?.excerpt, 'Research group projects involve resilient computing across several networked applications.');
  assert.equal(report.candidates[0]?.research.observedTextMatchedSavedInterests, false);
  assert.equal(report.candidates[0]?.research.matchedSavedInterests, null);
  assert.equal(report.candidates[1]?.identity.established, false);
  assert.equal(report.candidates[1]?.profile.httpStatus, 200);
  assert.equal(report.candidates[1]?.profile.contentType, 'text/html');
  assert.equal(report.candidates[2]?.research.textExtracted, true);
  assert.equal(report.candidates[2]?.research.matchedSavedInterests, true);
  assert.equal(JSON.stringify(report).includes('Distributed Systems'), false);
  assert.equal(JSON.stringify(report).includes('example.edu'), false);
});
