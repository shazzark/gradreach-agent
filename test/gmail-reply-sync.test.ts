import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutreachAttempt } from '../src/domain/outreach-queue.ts';
import { GMAIL_READONLY_SCOPE, GmailTokenScopeError } from '../src/infrastructure/gmail-oauth.ts';
import {
  GmailReadError,
  GmailReplySyncService,
  createGmailReadClient,
  findReply,
  pendingReplyAttempts,
  senderAddress,
  type GmailReplyRecord,
  type GmailReplySyncClient,
  type GmailThreadMessage,
} from '../src/infrastructure/gmail-reply-sync.ts';

const OWNER = 'owner@example.com';
const PROFESSOR = 'prof@example.edu';
const SENT_AT = '2026-11-20T10:00:00.000Z';
const SENT_AT_MS = Date.parse(SENT_AT);
const SYNC_AT = '2026-11-20T12:00:00.000Z';

function sentAttempt(overrides: Partial<OutreachAttempt> = {}): OutreachAttempt {
  return {
    candidateId: 'candidate-1',
    recipientEmail: PROFESSOR,
    scheduledFor: SENT_AT,
    state: 'sent',
    sentAt: SENT_AT,
    providerMessageId: 'msg-1',
    replyStatus: 'no-response',
    ...overrides,
  };
}

class FakeGmail implements GmailReplySyncClient {
  owner = OWNER;
  threads = new Map<string, GmailThreadMessage[]>();
  threadByMessage = new Map<string, string>();
  ownerCalls = 0;
  threadIdCalls = 0;
  threadCalls = 0;
  ownerFailure?: Error;
  threadIdFailure?: Error;

  async ownerAddress(): Promise<string> {
    this.ownerCalls += 1;
    if (this.ownerFailure) throw this.ownerFailure;
    return this.owner;
  }

  async threadIdForMessage(messageId: string): Promise<string | undefined> {
    this.threadIdCalls += 1;
    if (this.threadIdFailure) throw this.threadIdFailure;
    return this.threadByMessage.get(messageId);
  }

  async threadMessages(threadId: string): Promise<GmailThreadMessage[]> {
    this.threadCalls += 1;
    return this.threads.get(threadId) ?? [];
  }

  withThread(messageId: string, threadId: string, messages: GmailThreadMessage[]): this {
    this.threadByMessage.set(messageId, threadId);
    this.threads.set(threadId, messages);
    return this;
  }
}

function memoryAttempts(attempts: OutreachAttempt[], recordResult = true) {
  const state = {
    attempts: attempts.map((attempt) => ({ ...attempt })),
    writes: [] as GmailReplyRecord[],
  };
  const matching = (input: GmailReplyRecord) => state.attempts.find((attempt) =>
    attempt.candidateId === input.candidateId &&
    attempt.providerMessageId === input.providerMessageId &&
    attempt.state === 'sent' &&
    (attempt.replyStatus === undefined || attempt.replyStatus === 'no-response'));
  return {
    state,
    repositories: {
      attempts: {
        listAll: async () => state.attempts.map((attempt) => ({ ...attempt })),
        recordReply: async (input: GmailReplyRecord) => {
          const attempt = matching(input);
          if (!attempt || !recordResult) return false;
          attempt.replyStatus = 'replied';
          attempt.replyRecordedAt = input.repliedAt;
          attempt.replyMessageId = input.replyMessageId;
          state.writes.push(input);
          return true;
        },
      },
    },
  };
}

test('records a professor reply discovered from thread headers only', async () => {
  const store = memoryAttempts([sentAttempt()]);
  const gmail = new FakeGmail().withThread('msg-1', 'thread-1', [
    { id: 'msg-1', labelIds: ['SENT'], from: `GradReach Owner <${OWNER}>`, internalDate: SENT_AT_MS },
    { id: 'msg-2', labelIds: ['INBOX', 'UNREAD'], from: `"Professor Example" <${PROFESSOR}>`, internalDate: SENT_AT_MS + 60_000 },
  ]);
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.status, 'complete');
  assert.equal(result.pendingAttempts, 1);
  assert.equal(result.threadsChecked, 1);
  assert.equal(result.repliesRecorded, 1);
  assert.deepEqual(store.state.writes, [{
    candidateId: 'candidate-1', providerMessageId: 'msg-1', replyMessageId: 'msg-2', repliedAt: SYNC_AT,
  }]);
  const recorded = store.state.attempts[0]!;
  assert.equal(recorded.replyStatus, 'replied');
  assert.equal(recorded.replyRecordedAt, SYNC_AT);
  assert.equal(recorded.replyMessageId, 'msg-2');
  // Only ids and counts are reported; no address, subject, or body can leak into the CLI output.
  assert.equal(JSON.stringify(result).includes('@'), false);
});

test('a thread that contains only the owner message is not a reply', async () => {
  const store = memoryAttempts([sentAttempt()]);
  const gmail = new FakeGmail().withThread('msg-1', 'thread-1', [
    { id: 'msg-1', labelIds: ['SENT'], from: OWNER, internalDate: SENT_AT_MS },
  ]);
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.status, 'complete');
  assert.equal(result.repliesRecorded, 0);
  assert.equal(store.state.writes.length, 0);
  assert.equal(store.state.attempts[0]!.replyStatus, 'no-response');
});

test('a professor message older than the send cannot be counted as a reply', async () => {
  const store = memoryAttempts([sentAttempt()]);
  const gmail = new FakeGmail().withThread('msg-1', 'thread-1', [
    { id: 'msg-0', labelIds: ['INBOX'], from: PROFESSOR, internalDate: SENT_AT_MS - 60_000 },
    { id: 'msg-1', labelIds: ['SENT'], from: OWNER, internalDate: SENT_AT_MS },
  ]);
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.repliesRecorded, 0);
  assert.equal(store.state.writes.length, 0);
});

test('an unrecognized sender header without a From address is ignored', async () => {
  const withoutReplyStatus = sentAttempt();
  delete withoutReplyStatus.replyStatus;
  const store = memoryAttempts([withoutReplyStatus]);
  const gmail = new FakeGmail().withThread('msg-1', 'thread-1', [
    { id: 'msg-2', labelIds: ['INBOX'], internalDate: SENT_AT_MS + 60_000 },
  ]);
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.repliesRecorded, 0);
  assert.equal(store.state.writes.length, 0);
});

test('a manual declined decision is never revisited and causes no mailbox call', async () => {
  const store = memoryAttempts([sentAttempt({ replyStatus: 'declined' })]);
  const gmail = new FakeGmail();
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.pendingAttempts, 0);
  assert.equal(gmail.ownerCalls, 0);
  assert.equal(store.state.attempts[0]!.replyStatus, 'declined');
});

test('an attempt already marked replied is skipped without a mailbox call', async () => {
  const store = memoryAttempts([sentAttempt({ replyStatus: 'replied', replyRecordedAt: SENT_AT, replyMessageId: 'msg-2' })]);
  const gmail = new FakeGmail();
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.pendingAttempts, 0);
  assert.equal(gmail.ownerCalls, 0);
});

test('unsent or unclaimed attempts and duplicate provider ids are not scanned', async () => {
  const withoutProviderId = sentAttempt();
  delete withoutProviderId.providerMessageId;
  const attempts: OutreachAttempt[] = [
    withoutProviderId,
    sentAttempt({ candidateId: 'candidate-2', state: 'queued' }),
    sentAttempt({ candidateId: 'candidate-3', state: 'failed' }),
    sentAttempt(),
  ];
  const pending = pendingReplyAttempts(attempts);
  assert.deepEqual(pending.map((attempt) => attempt.candidateId), ['candidate-1']);
});



test('a missing read-only scope fails the run before any database write', async () => {
  const store = memoryAttempts([sentAttempt()]);
  const gmail = new FakeGmail();
  gmail.ownerFailure = new GmailReadError('gmail-read-scope-missing', 'synthetic scope failure');
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failure, { code: 'gmail-read-scope-missing' });
  assert.equal(result.repliesRecorded, 0);
  assert.equal(store.state.writes.length, 0);
  assert.equal(gmail.threadIdCalls, 0);
});

test('an authorization rejection stops the run after the first thread', async () => {
  const store = memoryAttempts([
    sentAttempt(),
    sentAttempt({ candidateId: 'candidate-2', providerMessageId: 'msg-9' }),
  ]);
  const gmail = new FakeGmail();
  gmail.threadIdFailure = new GmailReadError('gmail-read-auth-unavailable', 'synthetic auth failure', 401);
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failure, { code: 'gmail-read-auth-unavailable' });
  assert.equal(gmail.threadIdCalls, 1);
  assert.equal(result.checkedAttempts, 1);
  assert.equal(store.state.writes.length, 0);
});

test('a vanished thread is reported and the remaining threads are still checked', async () => {
  const store = memoryAttempts([
    sentAttempt(),
    sentAttempt({ candidateId: 'candidate-2', providerMessageId: 'msg-9' }),
  ]);
  const gmail = new FakeGmail().withThread('msg-9', 'thread-9', [
    { id: 'msg-10', labelIds: ['INBOX'], from: `"Professor Example" <${PROFESSOR}>`, internalDate: SENT_AT_MS + 120_000 },
  ]);
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.threadFailures, [{ candidateId: 'candidate-1', code: 'thread-unavailable' }]);
  assert.equal(result.repliesRecorded, 1);
  assert.equal(store.state.writes[0]!.candidateId, 'candidate-2');
});


test('a provider 429 is sanitized to a code and does not abort the run', async () => {
  const store = memoryAttempts([
    sentAttempt(),
    sentAttempt({ candidateId: 'candidate-2', providerMessageId: 'msg-9' }),
  ]);
  const gmail = new FakeGmail().withThread('msg-9', 'thread-9', [
    { id: 'msg-10', labelIds: ['INBOX'], from: PROFESSOR, internalDate: SENT_AT_MS + 120_000 },
  ]);
  let calls = 0;
  const flaky: GmailReplySyncClient = {
    ownerAddress: () => gmail.ownerAddress(),
    threadIdForMessage: async (messageId) => {
      calls += 1;
      if (calls === 1) throw new GmailReadError('gmail-read-request-failed', 'Gmail read request failed with HTTP 429', 429);
      return gmail.threadIdForMessage(messageId);
    },
    threadMessages: (threadId) => gmail.threadMessages(threadId),
  };
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: flaky }).sync(SYNC_AT);

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.threadFailures.map((failure) => failure.code), ['gmail-read-request-failed']);
  assert.equal(result.repliesRecorded, 1);
});

test('a reply already saved by another process is counted without a second write', async () => {
  const store = memoryAttempts([sentAttempt()], false);
  const gmail = new FakeGmail().withThread('msg-1', 'thread-1', [
    { id: 'msg-2', labelIds: ['INBOX'], from: PROFESSOR, internalDate: SENT_AT_MS + 60_000 },
  ]);
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.repliesRecorded, 0);
  assert.equal(result.replyAlreadyRecorded, 1);
  assert.equal(store.state.writes.length, 0);
});

test('the per-run thread limit defers the remainder', async () => {
  const store = memoryAttempts([
    sentAttempt(),
    sentAttempt({ candidateId: 'candidate-2', providerMessageId: 'msg-9' }),
  ]);
  const gmail = new FakeGmail();
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail, maxThreadsPerRun: 1 }).sync(SYNC_AT);

  assert.equal(result.pendingAttempts, 2);
  assert.equal(result.checkedAttempts, 1);
  assert.equal(result.deferredAttempts, 1);
  assert.equal(gmail.threadIdCalls, 1);
});

test('no pending attempt means no mailbox access at all', async () => {
  const store = memoryAttempts([sentAttempt({ state: 'queued' })]);
  const gmail = new FakeGmail();
  const result = await new GmailReplySyncService({ repositories: store.repositories, client: gmail }).sync(SYNC_AT);

  assert.equal(result.status, 'complete');
  assert.equal(result.pendingAttempts, 0);
  assert.equal(gmail.ownerCalls, 0);
});

test('the service rejects an invalid clock and an invalid run limit', async () => {
  const store = memoryAttempts([]);
  assert.throws(() => new GmailReplySyncService({ repositories: store.repositories, client: new FakeGmail(), maxThreadsPerRun: 0 }), /maxThreadsPerRun/);
  await assert.rejects(new GmailReplySyncService({ repositories: store.repositories, client: new FakeGmail() }).sync('not-a-date'), /now must be a valid date/);
});


test('the read client issues header-only GET requests and parses thread metadata', async () => {
  const requested: Array<{ url: string; method: string; authorization: string | null }> = [];
  let tokenCalls = 0;
  const client = createGmailReadClient({
    token: async () => { tokenCalls += 1; return 'synthetic-access-token'; },
    fetchImpl: async (input, init) => {
      const url = String(input);
      requested.push({ url, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'Owner@Example.com' });
      if (url.includes('/messages/msg-1')) return Response.json({ id: 'msg-1', threadId: 'thread-1' });
      if (url.includes('/threads/thread-1')) return Response.json({
        id: 'thread-1',
        messages: [
          { id: 'msg-1', labelIds: ['SENT'], internalDate: '1763546400000', payload: { headers: [{ name: 'From', value: `Owner <${OWNER}>` }] } },
          { id: 'msg-2', labelIds: ['INBOX'], internalDate: '1763546460000', payload: { headers: [{ name: 'From', value: `"Professor Example" <${PROFESSOR}>` }] } },
        ],
      });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(await client.ownerAddress(), OWNER);
  assert.equal(await client.threadIdForMessage('msg-1'), 'thread-1');
  assert.deepEqual(await client.threadMessages('thread-1'), [
    { id: 'msg-1', labelIds: ['SENT'], from: `Owner <${OWNER}>`, internalDate: 1763546400000 },
    { id: 'msg-2', labelIds: ['INBOX'], from: `"Professor Example" <${PROFESSOR}>`, internalDate: 1763546460000 },
  ]);
  assert.equal(tokenCalls, 1);
  assert.deepEqual(requested.map((request) => request.method), ['GET', 'GET', 'GET']);
  assert.equal(requested[0]!.url, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
  assert.equal(requested[1]!.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1?format=minimal&fields=threadId');
  assert.equal(requested[2]!.url, 'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1?format=metadata&metadataHeaders=From');
  assert.equal(requested.every((request) => request.authorization === 'Bearer synthetic-access-token'), true);
  assert.equal(requested.some((request) => /format=full|metadataHeaders=Subject|body/i.test(request.url)), false);
});

test('the read client rejects malformed provider ids before any request', async () => {
  let calls = 0;
  const client = createGmailReadClient({
    token: async () => 'synthetic-access-token',
    fetchImpl: async () => { calls += 1; return Response.json({}); },
  });
  const invalid = (error: unknown) => error instanceof GmailReadError && error.code === 'gmail-read-invalid-response';
  await assert.rejects(client.threadIdForMessage('../profile'), invalid);
  await assert.rejects(client.threadMessages('thread 1'), invalid);
  assert.equal(calls, 0);
});


test('the read client maps HTTP status to sanitized failure codes', async () => {
  let status = 404;
  const client = createGmailReadClient({
    token: async () => 'synthetic-access-token',
    fetchImpl: async () => new Response('provider detail that must never surface', { status }),
  });
  assert.equal(await client.threadIdForMessage('msg-1'), undefined);
  status = 401;
  await assert.rejects(client.threadIdForMessage('msg-1'), (error: unknown) =>
    error instanceof GmailReadError && error.code === 'gmail-read-auth-unavailable');
  status = 403;
  await assert.rejects(client.threadMessages('thread-1'), (error: unknown) =>
    error instanceof GmailReadError && error.code === 'gmail-read-scope-missing');
  status = 500;
  await assert.rejects(client.ownerAddress(), (error: unknown) =>
    error instanceof GmailReadError && error.code === 'gmail-read-request-failed' &&
    error.message === 'Gmail read request failed with HTTP 500');
});

test('a token authorized without the read scope surfaces as a scope failure', async () => {
  const client = createGmailReadClient({
    token: async () => { throw new GmailTokenScopeError(GMAIL_READONLY_SCOPE); },
    fetchImpl: async () => { throw new Error('the mailbox must not be contacted'); },
  });
  await assert.rejects(client.ownerAddress(), (error: unknown) =>
    error instanceof GmailReadError && error.code === 'gmail-read-scope-missing');
});
