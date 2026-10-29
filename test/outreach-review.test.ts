import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutreachAttempt, ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { approveCandidateForQueue } from '../src/application/outreach-review.ts';

const evidence: ProfessorCandidate['discoveryEvidence'] = [
  { kind: 'professor-profile', sourceUrl: 'https://university.example.edu/profile', excerpt: 'Reviewed profile excerpt.', retrievedAt: '2026-10-19T12:00:00Z', verification: 'reviewed', region: 'Exampleland', query: 'reviewed' },
  { kind: 'contact', sourceUrl: 'https://university.example.edu/contact', excerpt: 'Reviewed contact excerpt.', retrievedAt: '2026-10-19T12:00:00Z', verification: 'reviewed', region: 'Exampleland', query: 'reviewed' },
  { kind: 'program', sourceUrl: 'https://university.example.edu/msc', excerpt: 'Reviewed program excerpt.', retrievedAt: '2026-10-19T12:00:00Z', verification: 'reviewed', region: 'Exampleland', query: 'reviewed' },
];
const draft = JSON.stringify({
  candidateId: 'candidate-review', recipientEmail: 'dr@example.edu',
  subject: 'Prospective MSc applicant interested in systems',
  body: 'Dear Professor, I read your reviewed work: "Reviewed profile excerpt." I am interested in discussing your research group and the master\'s intake. Source: https://university.example.edu/profile',
  personalizationSourceUrl: 'https://university.example.edu/profile', personalizationExcerpt: 'Reviewed profile excerpt.', generatedAt: '2026-10-20T12:00:00.000Z',
});

const candidate: ProfessorCandidate = {
  id: 'candidate-review', name: 'Dr Example', institution: 'Example University', country: 'Exampleland',
  officialProfileUrl: 'https://university.example.edu/profile', officialEmail: 'dr@example.edu',
  emailSourceUrl: 'https://university.example.edu/contact', officialContactUrl: 'https://university.example.edu/contact', programUrl: 'https://university.example.edu/msc',
  sourceCheckedAt: '2026-10-19T12:00:00Z', fitSummary: 'Reviewed profile excerpt. connects to configured interest. Source: https://university.example.edu/profile',
  personalizedDraft: draft, status: 'ready-for-review', approvedForSending: false, priority: 1,
  discoveryEvidence: evidence,
};

test('approval is an explicit separate step after source and draft evidence are ready', () => {
  const approved = approveCandidateForQueue(candidate, []);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedForSending, true);
  assert.equal(candidate.status, 'ready-for-review');
  assert.equal(candidate.approvedForSending, false);
});

test('approval rejects unreviewed sources, incomplete drafts, and repeated recipients', () => {
  assert.throws(() => approveCandidateForQueue({ ...candidate, discoveryEvidence: evidence?.map((item) => ({ ...item, verification: 'unverified' as const })) }, []), /reviewed official professor profile/);
  assert.throws(() => approveCandidateForQueue({ ...candidate, fitSummary: '' }, []), /missing fitSummary/);
  const previous: OutreachAttempt = { candidateId: 'other', recipientEmail: 'DR@example.edu', scheduledFor: '2026-10-19T12:00:00Z', state: 'queued' };
  assert.throws(() => approveCandidateForQueue(candidate, [previous]), /already been scheduled or contacted/);
});
