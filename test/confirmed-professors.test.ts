import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';
import { parseConfirmedProfessorReports, type ConfirmedProfessorReportInput, type LocalOwnerDecisionInput } from '../src/application/confirmed-professors.ts';

const host = OFFICIAL_HOSTS_BY_REGION.Canada[0]!;
const profileUrl = `https://${host}/people/ada-example`;

function row(overrides: Record<string, unknown> = {}) {
  return {
    country: 'Canada',
    recordId: 'candidate-01',
    name: 'Ada Example',
    institution: 'Example University',
    identityVerified: true,
    officialProfileSource: profileUrl,
    researchSources: [{ url: profileUrl, supportingEvidence: 'The professor studies trustworthy machine learning methods.' }],
    interestMatch: 'not_evaluated',
    duplicate: false,
    outcome: 'stopped',
    reason: 'research_evidence_missing',
    reviewStatus: 'awaiting_owner_review',
    approved: false,
    queued: false,
    sent: false,
    ...overrides,
  };
}

function report(candidates: unknown[], reportName = 'continuation-batch-safe.json'): ConfirmedProfessorReportInput {
  return { reportName, candidates };
}

test('report parsing includes only identity-confirmed people with official profile evidence', () => {
  const parsed = parseConfirmedProfessorReports([report([
    row(),
    row({ recordId: 'candidate-02', identityVerified: false, name: 'Directory of Computer Science' }),
    row({ recordId: 'candidate-03', officialProfileSource: 'https://example.net/person' }),
    row({ recordId: 'candidate-04', name: 'Unidentified result' }),
  ])]);

  assert.equal(parsed.professors.length, 1);
  assert.equal(parsed.professors[0]?.name, 'Ada Example');
  assert.equal(parsed.excludedByReason.identity_not_established, 1);
  assert.equal(parsed.excludedByReason.official_profile_not_verified, 1);
  assert.equal(parsed.excludedByReason.name_missing, 1);
});

test('cross-report deduplication uses canonical profile URL and normalized person plus institution', () => {
  const parsed = parseConfirmedProfessorReports([
    report([row()], 'batch-a.json'),
    report([row({ recordId: 'candidate-08', officialProfileSource: `${profileUrl}?utm_source=fixture#bio`, duplicate: true })], 'batch-b.json'),
    report([row({ recordId: 'candidate-09', officialProfileSource: `https://${host}/people/another-ada`, name: ' ada   example ' })], 'batch-c.json'),
  ]);

  assert.equal(parsed.professors.length, 1);
  assert.equal(parsed.duplicateRowsConsolidated, 2);
  assert.equal(parsed.professors[0]?.duplicate, true);
  assert.equal(parsed.professors[0]?.sourceReports.length, 3);
});

test('professor confirmation remains separate from interest matching and lead qualification', () => {
  const parsed = parseConfirmedProfessorReports([report([row({
    researchSources: [], interestMatch: 'not_evaluated', outcome: 'stopped', reason: 'research_evidence_missing',
  })])]);
  const professor = parsed.professors[0]!;

  assert.equal(professor.name, 'Ada Example');
  assert.equal(professor.researchStatus, 'no_research_evidence');
  assert.deepEqual(professor.researchEvidence, []);
  assert.equal(professor.approved, false);
  assert.equal(professor.queued, false);
  assert.equal(professor.sent, false);
});

test('candidate-03 local acceptance is preserved without MongoDB or outreach approval', () => {
  const localDecision: LocalOwnerDecisionInput = {
    ownerDecision: 'accepted', decisionScope: 'local_preview_only', mongoSaved: false,
    sourceReport: 'candidate-03-owner-review.json',
    candidate: { professorName: 'Ada Example', institution: 'Example University', officialProfileUrl: profileUrl,
      researchEvidenceQuote: 'The professor studies trustworthy machine learning methods.', researchEvidenceSourceUrl: profileUrl,
      savedInterestMatchExplanation: 'The current matcher found an exact concept-level match.' },
  };
  const parsed = parseConfirmedProfessorReports([report([row()])], localDecision);
  const professor = parsed.professors[0]!;

  assert.equal(professor.localOwnerDecision, 'accepted_local_only');
  assert.ok(professor.sourceReports.includes('candidate-03-owner-review.json'));
  assert.equal(professor.researchStatus, 'matched');
  assert.equal(professor.researchEvidence[0]?.sourceUrl, profileUrl);
  assert.equal(professor.approved, false);
  assert.equal(professor.queued, false);
  assert.equal(professor.sent, false);
});

test('research status uses strongest recorded outcome and keeps duplicate evidence merged', () => {
  const matched = row({ recordId: 'candidate-01', researchSources: [{ url: profileUrl, supportingEvidence: 'Verified research quote one.' }], interestMatch: 'not_evaluated' });
  const notMatched = row({ recordId: 'candidate-02', name: 'Bea Example', officialProfileSource: `https://${host}/people/bea-example`, researchSources: [{ url: `https://${host}/people/bea-example`, supportingEvidence: 'A separate official research statement.' }], interestMatch: 'not_matched' });
  const noEvidence = row({ recordId: 'candidate-03', name: 'Cal Example', officialProfileSource: `https://${host}/people/cal-example`, researchSources: [], interestMatch: 'not_evaluated', reason: 'research_evidence_missing' });
  const notEvaluated = row({ recordId: 'candidate-04', name: 'Dee Example', officialProfileSource: `https://${host}/people/dee-example`, researchSources: [{ url: `https://${host}/people/dee-example`, supportingEvidence: 'Official research text was saved.' }], interestMatch: 'not_evaluated' });
  const parsed = parseConfirmedProfessorReports([
    report([matched, notMatched, noEvidence, notEvaluated], 'first-report.json'),
    report([row({ recordId: 'candidate-01', interestMatch: 'matched', researchSources: [{ url: profileUrl, supportingEvidence: 'Verified research quote two.' }] })], 'later-match.json'),
  ]);
  const byName = new Map(parsed.professors.map((professor) => [professor.name, professor]));

  assert.equal(byName.get('Ada Example')?.researchStatus, 'matched');
  assert.equal(byName.get('Ada Example')?.researchEvidence.length, 2);
  assert.equal(byName.get('Bea Example')?.researchStatus, 'evidence_found_but_not_matched');
  assert.equal(byName.get('Cal Example')?.researchStatus, 'no_research_evidence');
  assert.equal(byName.get('Dee Example')?.researchStatus, 'not_evaluated');
  assert.equal(parsed.duplicateRowsConsolidated, 1);
});

test('later offline reevaluation match overrides an older recorded mismatch without exposing interests', () => {
  const profile = `https://${host}/people/ada-example`;
  const parsed = parseConfirmedProfessorReports([report([row({ officialProfileSource: profile })])], undefined, [
    { reportName: 'canada-replay.json', kind: 'replay', candidates: [{
      recordId: 'candidate-03', profile: { sourceUrl: profile }, identity: { established: true },
      research: { textExtracted: true, extractedSourceUrl: profile, observedTextMatchedSavedInterests: false,
        observedResearchExcerpts: [{ sourceUrl: profile, excerpt: 'Official profile research statement was captured.' }] },
    }] },
    { reportName: 'canada-reevaluation.json', kind: 'reevaluation', sourceReport: 'canada-replay.json', candidates: [{
      recordId: 'candidate-03', identityEstablished: true, researchSourceUrl: profile,
      supportingExcerpt: 'The saved offline reevaluation retained this research evidence.', researchGate: 'matched',
    }] },
  ]);

  assert.equal(parsed.professors[0]?.researchStatus, 'matched');
  assert.ok(parsed.professors[0]?.sourceReports.includes('canada-reevaluation.json'));
  assert.doesNotMatch(JSON.stringify(parsed), /observedTextMatchedSavedInterests/);
});

test('offline attribution rejection removes the older mismatch evidence from that other lead', () => {
  const researchUrl = `https://${host}/projects/another-investigator`;
  const parsed = parseConfirmedProfessorReports([report([row({
    recordId: 'candidate-01', researchSources: [{ url: researchUrl, supportingEvidence: 'This project was led by a different investigator.' }],
  })])], undefined, [
    { reportName: 'reevaluation.json', kind: 'reevaluation', sourceReport: 'replay.json', candidates: [{
      recordId: 'candidate-01', researchSourceUrl: researchUrl, supportingExcerpt: 'This project was led by a different investigator.', researchGate: 'other_named_lead',
    }] },
    { reportName: 'replay.json', kind: 'replay', candidates: [{
      recordId: 'candidate-01', profile: { sourceUrl: profileUrl }, identity: { established: true },
      research: { textExtracted: true, extractedSourceUrl: researchUrl, observedTextMatchedSavedInterests: false,
        observedResearchExcerpts: [{ sourceUrl: researchUrl, excerpt: 'This project was led by a different investigator.' }] },
    }] },
  ]);

  assert.equal(parsed.professors[0]?.researchStatus, 'no_research_evidence');
  assert.deepEqual(parsed.professors[0]?.researchEvidence, []);
});

test('report parsing omits search fields and strips URLs and emails from evidence text', () => {
  const parsed = parseConfirmedProfessorReports([report([row({
    searchQuery: 'private query text',
    researchSources: [{ url: profileUrl, supportingEvidence: 'Studies AI. Contact person@example.edu or see https://private.example/data?q=x.' }],
  })])]);
  const serialized = JSON.stringify(parsed);

  assert.doesNotMatch(serialized, /private query text|person@example\.edu|https:\/\/private\.example/);
  assert.match(serialized, /\[email omitted\]/);
  assert.match(serialized, /\[link omitted\]/);
});
