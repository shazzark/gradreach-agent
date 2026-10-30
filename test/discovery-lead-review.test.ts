import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { acceptDiscoveredProfessorLead, rejectDiscoveredProfessorLead } from '../src/application/discovery-lead-review.ts';

const candidate: ProfessorCandidate = {
  id: 'professor-lead-1', name: 'Dr Example', institution: 'Example University', country: 'Exampleland',
  leadType: 'professor_profile', officialProfileUrl: 'https://university.example.edu/people/example',
  officialEmail: 'example@university.example.edu', emailSourceUrl: 'https://university.example.edu/people/example',
  discoveryEvidence: [
    { kind: 'professor-profile', sourceUrl: 'https://university.example.edu/people/example', excerpt: 'Dr Example researches safe systems.', quote: 'Dr Example researches safe systems.', retrievedAt: '2026-10-30T12:00:00.000Z', verification: 'unverified', region: 'Exampleland', query: 'ignored' },
    { kind: 'contact', sourceUrl: 'https://university.example.edu/people/example', excerpt: 'Dr Example: example@university.example.edu', retrievedAt: '2026-10-30T12:00:00.000Z', verification: 'unverified', region: 'Exampleland', query: 'ignored' },
    { kind: 'search-result', sourceUrl: 'https://university.example.edu/search-result', excerpt: 'Search result.', retrievedAt: '2026-10-30T12:00:00.000Z', verification: 'unverified', region: 'Exampleland', query: 'ignored' },
  ],
  status: 'needs-evidence', approvedForSending: false, priority: 0,
};

test('accepting a professor lead reviews only displayed official evidence and keeps outreach unapproved', () => {
  const accepted = acceptDiscoveredProfessorLead(candidate, '2026-10-30T13:00:00.000Z');
  assert.equal(accepted.discoveryReview?.decision, 'accepted');
  assert.equal(accepted.status, 'ready-for-review');
  assert.equal(accepted.approvedForSending, false);
  assert.deepEqual(accepted.discoveryEvidence?.map((item) => item.verification), ['reviewed', 'reviewed', 'unverified']);
  assert.equal(candidate.status, 'needs-evidence');
  assert.equal(candidate.discoveryReview, undefined);
});

test('rejecting a professor lead records the human decision without reviewing evidence or approving outreach', () => {
  const rejected = rejectDiscoveredProfessorLead(candidate, '2026-10-30T13:00:00.000Z');
  assert.equal(rejected.discoveryReview?.decision, 'rejected');
  assert.equal(rejected.status, 'needs-evidence');
  assert.equal(rejected.approvedForSending, false);
  assert.ok(rejected.discoveryEvidence?.every((item) => item.verification === 'unverified'));
});

test('review decisions reject non-professor, already decided, or invalid timestamp inputs', () => {
  assert.throws(() => acceptDiscoveredProfessorLead({ ...candidate, leadType: 'school' }), /undecided professor leads/);
  assert.throws(() => rejectDiscoveredProfessorLead({ ...candidate, discoveryReview: { decision: 'accepted', reviewedAt: '2026-10-30T13:00:00.000Z' } }), /undecided professor leads/);
  assert.throws(() => acceptDiscoveredProfessorLead(candidate, 'invalid-date'), /valid date/);
});
