import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalDateKey, selectDailyOutreachBatch, type ProfessorCandidate } from '../src/domain/outreach-queue.ts';

function candidate(overrides: Partial<ProfessorCandidate> = {}): ProfessorCandidate {
  const id = overrides.id ?? 'p-1';
  return {
    id,
    name: `Professor ${id}`,
    institution: 'Example University',
    country: 'Example country',
    officialProfileUrl: 'https://university.example.edu/profile',
    officialEmail: `${id}@university.example.edu`,
    emailSourceUrl: 'https://university.example.edu/contact',
    programUrl: 'https://university.example.edu/masters/computer-science',
    fundingSourceUrl: 'https://university.example.edu/funding',
    eligibilitySourceUrl: 'https://university.example.edu/admissions',
    sourceCheckedAt: '2026-10-19',
    fitSummary: 'Their work on distributed software systems connects to the applicant’s project experience.',
    personalizedDraft: 'Dear Professor, I read your official lab page and am interested in your MSc group.',
    status: 'approved',
    approvedForSending: true,
    priority: 1,
    ...overrides,
  };
}

test('selects at most five approved, evidence-complete, unique recipients', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => candidate({ id: `p-${index + 1}`, priority: 8 - index }));
  const result = selectDailyOutreachBatch({ candidates, attempts: [], now: '2026-10-19T09:00:00+01:00', timeZone: 'Africa/Lagos' });
  assert.equal(result.dateKey, '2026-10-19');
  assert.equal(result.selected.length, 5);
  assert.equal(result.remainingCapacity, 5);
  assert.ok(result.skipped.every((entry) => entry.reason === 'daily limit reached'));
});

test('reduces capacity for attempts already scheduled or sent today', () => {
  const result = selectDailyOutreachBatch({
    candidates: Array.from({ length: 5 }, (_, index) => candidate({ id: `p-${index + 1}` })),
    attempts: [
      { candidateId: 'old-1', recipientEmail: 'old1@example.edu', scheduledFor: '2026-10-19T10:00:00+01:00', state: 'sent' },
      { candidateId: 'old-2', recipientEmail: 'old2@example.edu', scheduledFor: '2026-10-19T11:00:00+01:00', state: 'queued' },
    ],
    now: '2026-10-19T09:00:00+01:00',
    timeZone: 'Africa/Lagos',
  });
  assert.equal(result.remainingCapacity, 3);
  assert.equal(result.selected.length, 3);
});

test('does not reuse a professor or email address already attempted', () => {
  const result = selectDailyOutreachBatch({
    candidates: [candidate({ id: 'p-1' }), candidate({ id: 'p-2', officialEmail: 'p-1@university.example.edu' }), candidate({ id: 'p-3' })],
    attempts: [{ candidateId: 'p-3', recipientEmail: 'p-3@university.example.edu', scheduledFor: '2026-10-18T12:00:00Z', state: 'sent' }],
    now: '2026-10-19T09:00:00+01:00',
    timeZone: 'Africa/Lagos',
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ['p-1']);
  assert.equal(result.skipped.length, 2);
});

test('does not queue candidates with missing contact or fit evidence', () => {
  const withoutEmailSource = candidate({ id: 'no-evidence' });
  delete withoutEmailSource.emailSourceUrl;
  const result = selectDailyOutreachBatch({
    candidates: [withoutEmailSource],
    attempts: [],
    now: '2026-10-19T09:00:00+01:00',
    timeZone: 'Africa/Lagos',
  });
  assert.equal(result.selected.length, 0);
  assert.match(result.skipped[0]?.reason ?? '', /emailSourceUrl/);
});

test('allows an outreach question when funding eligibility is still unknown', () => {
  const unknownFunding = candidate({ id: 'unknown-funding' });
  delete unknownFunding.fundingSourceUrl;
  delete unknownFunding.eligibilitySourceUrl;
  const result = selectDailyOutreachBatch({
    candidates: [unknownFunding],
    attempts: [],
    now: '2026-10-19T09:00:00+01:00',
    timeZone: 'Africa/Lagos',
  });
  assert.equal(result.selected.length, 1);
});

test('uses Africa/Lagos local calendar date across UTC midnight', () => {
  assert.equal(getLocalDateKey('2026-10-18T23:30:00Z', 'Africa/Lagos'), '2026-10-19');
});
