import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { buildDashboardSnapshot, candidatesToCsv } from '../src/application/dashboard.ts';
import { formatReviewQueue } from '../src/interfaces/terminal-app.ts';

const reviewedCandidate: ProfessorCandidate = {
  id: 'p1', name: 'Professor One', institution: 'Example University', country: 'Exampleland',
  officialProfileUrl: 'https://university.example.edu/profile', officialEmail: 'p1@example.edu',
  emailSourceUrl: 'https://university.example.edu/contact', programUrl: 'https://university.example.edu/msc',
  sourceCheckedAt: '2026-10-19T10:00:00Z', fitSummary: 'Verified fit.', personalizedDraft: 'Source-cited draft.',
  status: 'approved', approvedForSending: true, priority: 1,
  discoveryEvidence: [{ kind: 'professor-profile', sourceUrl: 'https://university.example.edu/profile', excerpt: 'Reviewed.', retrievedAt: '2026-10-19T10:00:00Z', verification: 'reviewed', region: 'Exampleland', query: 'fixture' }],
};

test('builds queue and research progress using the configured local day and pause state', () => {
  const snapshot = buildDashboardSnapshot({
    candidates: [reviewedCandidate], programs: [], assessments: [],
    attempts: [{ candidateId: 'prior', recipientEmail: 'prior@example.edu', scheduledFor: '2026-10-20T00:30:00Z', state: 'sent' }],
    control: { paused: false, timeZone: 'Africa/Lagos', dailyLimit: 5 }, now: '2026-10-20T01:00:00Z',
  });
  assert.equal(snapshot.targetPoolSize, 200);
  assert.equal(snapshot.profilesReviewed, 1);
  assert.equal(snapshot.sentToday, 1);
  assert.equal(snapshot.dailyCapacityRemaining, 4);
  assert.deepEqual(snapshot.proposedCandidateIds, ['p1']);
});

test('CSV export escapes quotes and protects spreadsheet formula cells', () => {
  const candidate = { ...reviewedCandidate, name: '=HYPERLINK("https://bad.example")' };
  const csv = candidatesToCsv([candidate]);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/bad\.example""\)"/);
  assert.match(csv, /"https:\/\/university\.example\.edu\/profile"/);
  assert.ok(csv.includes('\r\n'));
});

test('review display includes source links and draft text for human inspection', () => {
  const candidate = { ...reviewedCandidate, personalizedDraft: 'Dear Professor, this draft cites reviewed evidence.' };
  const output = formatReviewQueue([candidate]);
  assert.match(output, /https:\/\/university\.example\.edu\/profile/);
  assert.match(output, /Dear Professor, this draft cites reviewed evidence/);
});
