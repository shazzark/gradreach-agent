import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutreachAttempt, ProfessorCandidate, SchedulerControl } from '../src/domain/outreach-queue.ts';
import { draftFingerprint } from '../src/application/outreach-review.ts';
import { GmailDeliveryError, GmailDeliveryService } from '../src/infrastructure/gmail-oauth.ts';

const profileUrl = 'https://university.example.edu/profile';
const contactUrl = 'https://university.example.edu/contact';
const programUrl = 'https://university.example.edu/msc';
const excerpt = 'The group studies resilient distributed systems.';

function approvedCandidate(id: string): ProfessorCandidate {
  const draft = {
    candidateId: id, recipientEmail: `${id}@example.edu`, subject: 'Prospective MSc research inquiry',
    body: `Dear Professor. I read this passage: "${excerpt}" It matches my stated interest. Source: ${profileUrl}`,
    personalizationSourceUrl: profileUrl, personalizationExcerpt: excerpt, generatedAt: '2026-10-20T08:00:00.000Z',
  };
  return {
    id, name: `Professor ${id}`, institution: 'Example University', country: 'Exampleland',
    officialProfileUrl: profileUrl, officialContactUrl: contactUrl, officialEmail: draft.recipientEmail,
    emailSourceUrl: contactUrl, programUrl, sourceCheckedAt: '2026-10-19T12:00:00.000Z',
    discoveryEvidence: [
      { kind: 'professor-profile', sourceUrl: profileUrl, excerpt, retrievedAt: '2026-10-19T12:00:00.000Z', verification: 'reviewed', region: 'Exampleland', query: 'reviewed' },
      { kind: 'contact', sourceUrl: contactUrl, excerpt: 'Official contact details.', retrievedAt: '2026-10-19T12:00:00.000Z', verification: 'reviewed', region: 'Exampleland', query: 'reviewed' },
      { kind: 'program', sourceUrl: programUrl, excerpt: 'Official MSc information.', retrievedAt: '2026-10-19T12:00:00.000Z', verification: 'reviewed', region: 'Exampleland', query: 'reviewed' },
    ],
    fitSummary: `The excerpt "${excerpt}" relates to configured interest. Source: ${profileUrl}`,
    personalizedDraft: JSON.stringify(draft), approvedDraftHash: draftFingerprint(draft), approvedAt: '2026-10-20T08:01:00.000Z',
    status: 'approved', approvedForSending: true, priority: 1,
  };
}

class MemoryDeliveryStore {
  readonly candidates = new Map<string, ProfessorCandidate>();
  readonly attempts: OutreachAttempt[] = [];
  control: SchedulerControl = { paused: false, timeZone: 'Africa/Lagos', dailyLimit: 5 };
  reservedDate = '';
  reservedCount = 0;

  readonly repositories = {
    candidates: {
      get: async (id: string) => this.candidates.get(id),
      markSent: async (id: string) => {
        const candidate = this.candidates.get(id);
        if (!candidate || candidate.status !== 'approved' || !candidate.approvedForSending) return false;
        candidate.status = 'sent'; candidate.approvedForSending = false;
        return true;
      },
    },
    attempts: {
      listAll: async () => this.attempts.map((attempt) => ({ ...attempt })),
      claimForDelivery: async (attempt: OutreachAttempt, now: string, maxAttempts: number) => {
        const found = this.find(attempt);
        const retryDue = found.state === 'failed' && Boolean(found.nextAttemptAt) && new Date(found.nextAttemptAt!) <= new Date(now);
        if (found.state !== 'queued' && !retryDue) return undefined;
        if ((found.deliveryAttempts ?? 0) >= maxAttempts) return undefined;
        found.state = 'sending'; found.deliveryAttempts = (found.deliveryAttempts ?? 0) + 1; found.lastAttemptAt = now;
        delete found.nextAttemptAt;
        return { ...found };
      },
      updateDelivery: async (updated: OutreachAttempt) => {
        const found = this.find(updated);
        if (found.state !== 'sending') return false;
        Object.assign(found, updated);
        return true;
      },
      releaseClaim: async (attempt: OutreachAttempt) => { this.find(attempt).state = 'queued'; },
      rejectQueued: async (attempt: OutreachAttempt, failureCode: string) => { const found = this.find(attempt); found.state = 'failed'; found.failureCode = failureCode; },
      recoverStaleSending: async () => 0,
    },
    schedulerControl: {
      get: async () => ({ ...this.control }),
      reserveDailySend: async (now: string) => {
        if (this.control.paused) return false;
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: this.control.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
        if (date !== this.reservedDate) { this.reservedDate = date; this.reservedCount = 0; }
        if (this.reservedCount >= this.control.dailyLimit) return false;
        this.reservedCount += 1;
        return true;
      },
    },
  };

  add(id: string, scheduledFor = '2026-10-20T08:00:00.000Z'): void {
    const candidate = approvedCandidate(id);
    this.candidates.set(id, candidate);
    this.attempts.push({ candidateId: id, recipientEmail: candidate.officialEmail!, scheduledFor, state: 'queued' });
  }

  private find(attempt: OutreachAttempt): OutreachAttempt {
    const found = this.attempts.find((item) => item.candidateId === attempt.candidateId && item.scheduledFor === attempt.scheduledFor);
    if (!found) throw new Error('synthetic attempt missing');
    return found;
  }
}

test('delivery is disabled by default and never calls the provider', async () => {
  const store = new MemoryDeliveryStore(); store.add('p1');
  let sends = 0;
  const service = new GmailDeliveryService({ repositories: store.repositories, send: async () => { sends += 1; return 'synthetic-id'; }, sendingEnabled: false });
  assert.equal((await service.deliverNext('2026-10-20T09:00:00.000Z')).status, 'disabled');
  assert.equal(sends, 0);
});

test('delivery requires explicit candidate approval and an unchanged approved draft', async () => {
  const store = new MemoryDeliveryStore(); store.add('p1');
  const altered = store.candidates.get('p1')!;
  altered.personalizedDraft = altered.personalizedDraft!.replace('Prospective MSc', 'Urgent funding');
  let sends = 0;
  const service = new GmailDeliveryService({ repositories: store.repositories, send: async () => { sends += 1; return 'synthetic-id'; }, sendingEnabled: true });
  const result = await service.deliverNext('2026-10-20T09:00:00.000Z');
  assert.equal(result.status, 'empty');
  assert.equal(store.attempts[0]?.state, 'failed');
  assert.equal(store.attempts[0]?.failureCode, 'approved-draft-changed');
  assert.equal(sends, 0);
});

test('paused queue blocks delivery before provider call', async () => {
  const store = new MemoryDeliveryStore(); store.add('p1'); store.control.paused = true;
  let sends = 0;
  const service = new GmailDeliveryService({ repositories: store.repositories, send: async () => { sends += 1; return 'synthetic-id'; }, sendingEnabled: true });
  assert.equal((await service.deliverNext('2026-10-20T09:00:00.000Z')).status, 'paused');
  assert.equal(sends, 0);
  assert.equal(store.attempts[0]?.state, 'queued');
});

test('concurrent delivery workers reserve no more than five local-day sends and do not duplicate attempts', async () => {
  const store = new MemoryDeliveryStore();
  for (let index = 0; index < 7; index += 1) store.add(`p${index}`);
  let sends = 0;
  const service = new GmailDeliveryService({ repositories: store.repositories, sendingEnabled: true, send: async () => `synthetic-${++sends}` });
  const results = await Promise.all(Array.from({ length: 7 }, () => service.deliverNext('2026-10-20T09:00:00.000Z')));
  assert.equal(sends, 5);
  assert.equal(store.reservedCount, 5);
  assert.equal(store.attempts.filter((attempt) => attempt.state === 'sent').length, 5);
  assert.equal(new Set(store.attempts.filter((attempt) => attempt.state === 'sent').map((attempt) => attempt.candidateId)).size, 5);
  assert.ok(results.every((result) => ['delivered', 'daily-cap', 'empty'].includes(result.status)));
  assert.equal((await service.deliverNext('2026-10-20T09:00:00.000Z')).status, 'daily-cap');
  assert.equal(sends, 5);
});

test('explicitly rejected sends can retry with audit state; uncertain outcomes never retry automatically', async () => {
  const store = new MemoryDeliveryStore(); store.add('p1');
  let sends = 0;
  const retryService = new GmailDeliveryService({ repositories: store.repositories, sendingEnabled: true, send: async () => {
    sends += 1;
    if (sends === 1) throw new GmailDeliveryError('gmail-rate-limited', 'not-sent', true);
    return 'synthetic-message-id';
  } });
  const failed = await retryService.deliverNext('2026-10-20T09:00:00.000Z');
  assert.equal(failed.status, 'failed');
  assert.equal(store.attempts[0]?.state, 'failed');
  assert.ok(store.attempts[0]?.nextAttemptAt);
  assert.equal((await retryService.deliverNext('2026-10-20T09:00:30.000Z')).status, 'empty');
  const sent = await retryService.deliverNext('2026-10-20T09:03:00.000Z');
  assert.equal(sent.status, 'delivered');
  assert.equal(store.attempts[0]?.deliveryAttempts, 2);
  assert.equal(store.attempts[0]?.providerMessageId, 'synthetic-message-id');
  assert.equal(store.candidates.get('p1')?.status, 'sent');

  const unknownStore = new MemoryDeliveryStore(); unknownStore.add('p2');
  let unknownSends = 0;
  const unknownService = new GmailDeliveryService({ repositories: unknownStore.repositories, sendingEnabled: true, send: async () => { unknownSends += 1; throw new Error('transport interrupted'); } });
  assert.equal((await unknownService.deliverNext('2026-10-20T09:00:00.000Z')).status, 'uncertain');
  assert.equal((await unknownService.deliverNext('2026-10-20T09:10:00.000Z')).status, 'empty');
  assert.equal(unknownSends, 1);
});
