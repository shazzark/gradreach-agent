import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { planDailyOutreach } from '../src/application/daily-outreach-planner.ts';

function candidate(id: string): ProfessorCandidate {
  return {
    id, name: `Professor ${id}`, institution: 'Example University', country: 'Exampleland',
    officialProfileUrl: 'https://university.example.edu/profile', officialEmail: `${id}@example.edu`,
    emailSourceUrl: 'https://university.example.edu/contact', programUrl: 'https://university.example.edu/msc',
    sourceCheckedAt: '2026-10-19T12:00:00Z', fitSummary: 'Reviewed research match.',
    personalizedDraft: 'Source-cited reviewed outreach draft.', status: 'approved', approvedForSending: true, priority: 1,
  };
}

const control = { paused: false, timeZone: 'Africa/Lagos', dailyLimit: 5 };

test('paused planner creates no queue records and keeps candidate review state untouched', () => {
  const candidates = [candidate('p1')];
  const result = planDailyOutreach({ control: { ...control, paused: true }, candidates, attempts: [], now: '2026-10-20T09:00:00Z' });
  assert.equal(result.paused, true);
  assert.deepEqual(result.attemptsToQueue, []);
  assert.equal(result.selection.selected.length, 0);
  assert.equal(result.selection.remainingCapacity, 5);
  assert.equal(result.selection.skipped[0]?.reason, 'scheduler is paused');
  assert.equal(candidates[0]?.approvedForSending, true);
});

test('active planner proposes no more than five queued audit records and never sends', () => {
  const result = planDailyOutreach({
    control,
    candidates: Array.from({ length: 8 }, (_, index) => candidate(`p${index + 1}`)),
    attempts: [],
    now: '2026-10-20T09:00:00Z',
  });
  assert.equal(result.paused, false);
  assert.equal(result.attemptsToQueue.length, 5);
  assert.ok(result.attemptsToQueue.every((attempt) => attempt.state === 'queued'));
  assert.ok(result.attemptsToQueue.every((attempt) => attempt.scheduledFor === '2026-10-20T09:00:00.000Z'));
});

test('planner enforces the same hard daily cap and validates its timezone', () => {
  assert.throws(() => planDailyOutreach({ control: { ...control, dailyLimit: 6 }, candidates: [], attempts: [], now: '2026-10-20T09:00:00Z' }), /dailyLimit must be an integer from 1 to 5/);
  assert.throws(() => planDailyOutreach({ control: { ...control, timeZone: 'Not/AZone' }, candidates: [], attempts: [], now: '2026-10-20T09:00:00Z' }), /Invalid time zone/);
});
