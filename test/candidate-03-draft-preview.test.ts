import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';
import { createCandidate03DraftPreview } from '../src/interfaces/preview-candidate-03-draft.ts';

const profile = parseApplicantProfile(JSON.parse(await readFile(new URL('../private.profile.example.json', import.meta.url), 'utf8')));
profile.applicant.fullName = 'Synthetic Applicant';
profile.applicant.target.intake = 'Fall 2027';
profile.applicant.target.researchInterests = ['Cybersecurity, privacy, and network security', 'AI and machine learning'];
profile.applicant.degree.title = 'BSc Computer Science';
profile.applicant.degree.institution = 'Example College';

const officialProfileUrl = `https://${OFFICIAL_HOSTS_BY_REGION.Canada[0]}/electrical-computer-engineering/profile/ecreager`;
const excerpt = 'Dr. Creager’s research spans a range of topics within machine learning, with a focus on algorithmic fairness, representation learning, and robustness.';
const ownerReview = {
  ownerDecision: 'accepted', decisionScope: 'local_preview_only', mongoSaved: false,
  candidate: { professorName: 'Elliot Creager', institution: 'University of Waterloo', officialProfileUrl },
};
const evaluation = {
  reportName: 'canada-offline-reevaluation-test.json',
  record: { recordId: 'candidate-03', identityEstablished: true, researchSourceUrl: officialProfileUrl, supportingExcerpt: excerpt, researchGate: 'matched' },
};

test('builds a private local preview from accepted identity and matched official evidence without a recipient or database write', async () => {
  const preview = await createCandidate03DraftPreview({ profile, ownerReview, evaluation, now: '2026-11-09T12:00:00Z' });
  assert.equal(preview.recipientEmail, null);
  assert.equal(preview.recipientStatus, 'unavailable');
  assert.equal(preview.mongoWrites, 0);
  assert.equal(preview.approved, false);
  assert.equal(preview.queued, false);
  assert.equal(preview.sent, false);
  assert.match(preview.subject, /AI and machine learning/);
  assert.ok(preview.body.includes(excerpt));
  assert.ok(preview.claimSupport.some(({ claim }) => claim === 'Quoted research statement'));
  assert.ok(preview.claimSupport.some(({ claim, evidence }) => claim === 'Applicant academic background' && evidence.includes('owner-provided')));
  assert.doesNotMatch(JSON.stringify(preview), /@|SEARCH_PROVIDER_API_KEY|MONGODB_URI/);
});

test('refuses the local preview unless candidate-03 was accepted locally and evaluation still confirms a match', async () => {
  await assert.rejects(createCandidate03DraftPreview({ profile, ownerReview: { ...ownerReview, mongoSaved: true }, evaluation }), /local_evidence_incomplete/);
  await assert.rejects(createCandidate03DraftPreview({ profile, ownerReview, evaluation: { ...evaluation, record: { ...evaluation.record, researchGate: 'not_matched' } } }), /local_evidence_incomplete/);
});
