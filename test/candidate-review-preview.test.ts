import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import {
  DEFAULT_REVIEW_REGION, compareSavedLeadDuplicates, createCandidateReviewPreview, resolveReviewRegion, stableProfileCandidateId,
  type CandidateReviewIdentity,
} from '../src/application/candidate-review-preview.ts';
import { identityFromExcerpt, requestedReviewRegion } from '../src/interfaces/prepare-candidate-review-preview.ts';

const REVIEW_REGION = 'Canada';

const identity: CandidateReviewIdentity = {
  professorName: 'Elliot Creager',
  institution: 'University of Waterloo',
  officialProfileUrl: 'https://uwaterloo.ca/electrical-computer-engineering/profile/ecreager',
};

type CandidateOverrides = Omit<Partial<ProfessorCandidate>, 'professorName' | 'officialProfileUrl'> & { professorName?: string | undefined; officialProfileUrl?: string | undefined };
function saved(overrides: CandidateOverrides = {}): ProfessorCandidate {
  const value: ProfessorCandidate = {
    id: 'old-stable-id', name: 'Saved title', institution: identity.institution, country: 'Canada', professorName: identity.professorName,
    officialProfileUrl: identity.officialProfileUrl, status: 'needs-evidence', approvedForSending: false, priority: 0,
  };
  Object.assign(value, overrides);
  if (Object.hasOwn(overrides, 'professorName') && overrides.professorName === undefined) delete value.professorName;
  if (Object.hasOwn(overrides, 'officialProfileUrl') && overrides.officialProfileUrl === undefined) delete value.officialProfileUrl;
  return value;
}

test('candidate-03 identity is extracted only from the recorded named academic-role excerpt', () => {
  assert.deepEqual(identityFromExcerpt('Elliot Creager — Assistant Professor', identity.officialProfileUrl), identity);
  assert.equal(identityFromExcerpt('Academic advising — service information', identity.officialProfileUrl), undefined);
});

test('duplicate comparison checks stable profile ID, canonical official URL, and person plus institution', () => {
  assert.equal(compareSavedLeadDuplicates(identity, [saved({ id: stableProfileCandidateId(identity.officialProfileUrl, REVIEW_REGION)! })], REVIEW_REGION).result, 'duplicate');
  assert.equal(compareSavedLeadDuplicates(identity, [saved({ professorName: undefined, institution: '', officialProfileUrl: `${identity.officialProfileUrl}#bio` })], REVIEW_REGION).reasonCode, 'canonical_profile_url');
  assert.equal(compareSavedLeadDuplicates(identity, [saved({ officialProfileUrl: undefined })], REVIEW_REGION).reasonCode, 'professor_and_institution');
  assert.equal(compareSavedLeadDuplicates(identity, [], REVIEW_REGION).result, 'not found');
});

test('invalid identity or non-allowlisted profile cannot be declared unique', () => {
  assert.equal(compareSavedLeadDuplicates({ ...identity, officialProfileUrl: 'https://example.org/person' }, [], REVIEW_REGION).result, 'could not verify');
  assert.equal(compareSavedLeadDuplicates(identity, [], 'Nowhere').result, 'could not verify');
  assert.equal(compareSavedLeadDuplicates({ ...identity, professorName: '' }, [], REVIEW_REGION).result, 'could not verify');
});

test('review region comes from the flag, then the environment, then a default that is announced', () => {
  assert.deepEqual(resolveReviewRegion({ flag: 'Germany', environment: 'Canada' }), { region: 'Germany', source: 'flag' });
  assert.deepEqual(resolveReviewRegion({ environment: ' Belgium ' }), { region: 'Belgium', source: 'environment' });
  const fallback = resolveReviewRegion();
  assert.equal(fallback.region, DEFAULT_REVIEW_REGION);
  assert.equal(fallback.source, 'default');
  assert.match(fallback.warning ?? '', /No review region was provided/);
  assert.match(fallback.warning ?? '', /--region/);
  assert.equal(resolveReviewRegion({ flag: '   ', environment: '' }).source, 'default');
});

test('review region arguments follow the discovery pilot flag syntax', () => {
  assert.equal(requestedReviewRegion(['--region', 'Germany']), 'Germany');
  assert.equal(requestedReviewRegion(['--region=Belgium']), 'Belgium');
  assert.equal(requestedReviewRegion(['--region']), undefined);
  assert.equal(requestedReviewRegion([]), undefined);
});

test('review preview includes evidence and explicitly remains pending without approval or outreach actions', () => {
  const preview = createCandidateReviewPreview({
    identity, recordId: 'candidate-03', researchEvidenceQuote: 'Research spans topics within machine learning.',
    researchEvidenceSourceUrl: identity.officialProfileUrl, checkedLeadCount: 11,
  });
  assert.equal(preview.status, 'awaiting owner review');
  assert.equal(preview.ownerDecision, 'pending');
  assert.equal(preview.approved, false);
  assert.equal(preview.queued, false);
  assert.equal(preview.sent, false);
  assert.equal(preview.candidate.researchEvidenceQuote, 'Research spans topics within machine learning.');
  assert.match(preview.candidate.savedInterestMatchExplanation, /exact concept-level match/);
  assert.doesNotMatch(JSON.stringify(preview), /applicant-secret-interest/);
});
