import type { OutreachAttempt } from '../domain/outreach-queue.ts';
import { GmailTokenScopeError, gmailReadOnlyAccessToken } from './gmail-oauth.ts';

const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REQUEST_TIMEOUT_MS = 15_000;
/** Provider ids are opaque; restricting the alphabet keeps them safe inside a request path. */
const GMAIL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** Quota guard for one manual run; the realistic pool is smaller, so a normal run defers nothing. */
export const DEFAULT_MAX_THREADS_PER_RUN = 200;

export type GmailReadFailureCode =
  | 'gmail-read-auth-unavailable'
  | 'gmail-read-scope-missing'
  | 'gmail-read-request-failed'
  | 'gmail-read-invalid-response'
  | 'thread-unavailable'
  | 'reply-record-failed';

/** Sanitized read failure: carries a stable code and at most an HTTP status, never response content. */
export class GmailReadError extends Error {
  readonly code: GmailReadFailureCode;
  readonly status: number | undefined;

  constructor(code: GmailReadFailureCode, message: string, status?: number) {
    super(message);
    this.name = 'GmailReadError';
    this.code = code;
    this.status = status;
  }
}

/** A header-only view of one message in a thread. Subject and body are never requested or stored. */
export interface GmailThreadMessage {
  id: string;
  labelIds: string[];
  /** Raw From header; compared only with the authenticated mailbox address. */
  from?: string;
  /** Provider receipt time in epoch milliseconds; used to ignore messages older than our send. */
  internalDate?: number;
}

/** Header-only Gmail reader. Every method is a GET; nothing in a mailbox is modified. */
export interface GmailReplySyncClient {
  ownerAddress(): Promise<string>;
  threadIdForMessage(messageId: string): Promise<string | undefined>;
  threadMessages(threadId: string): Promise<GmailThreadMessage[]>;
}

/** Creates the production read-only client; `token` and `fetchImpl` exist for deterministic tests. */
export function createGmailReadClient(options: {
  token?: () => Promise<string>;
  fetchImpl?: typeof fetch;
} = {}): GmailReplySyncClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  let pendingToken: Promise<string> | undefined;
  const token = (): Promise<string> => {
    if (!pendingToken) {
      pendingToken = (options.token ?? gmailReadOnlyAccessToken)().catch((error: unknown) => {
        pendingToken = undefined;
        if (error instanceof GmailTokenScopeError) {
          throw new GmailReadError('gmail-read-scope-missing', 'Gmail authorization does not include the read-only scope; run npm run ops:gmail-connect again');
        }
        throw new GmailReadError('gmail-read-auth-unavailable', 'Gmail read authorization is unavailable; run npm run ops:gmail-connect again');
      });
    }
    return pendingToken;
  };
  const get = async (path: string): Promise<unknown> => gmailGet(`${GMAIL_API_ROOT}${path}`, await token(), fetchImpl);

  return {
    async ownerAddress() {
      const address = normalizedAddress(recordOf(await get('/profile'))?.emailAddress);
      if (!address) throw new GmailReadError('gmail-read-invalid-response', 'Gmail profile response did not include a mailbox address');
      return address;
    },
    async threadIdForMessage(messageId) {
      if (!GMAIL_ID.test(messageId)) throw new GmailReadError('gmail-read-invalid-response', 'Saved provider message id is not a valid Gmail id');
      let payload: unknown;
      try {
        payload = await get(`/messages/${messageId}?format=minimal&fields=threadId`);
      } catch (error) {
        // A deleted or expired message cannot carry a reply; report it as unavailable instead of guessing.
        if (error instanceof GmailReadError && error.status === 404) return undefined;
        throw error;
      }
      const threadId = recordOf(payload)?.threadId;
      return typeof threadId === 'string' && GMAIL_ID.test(threadId) ? threadId : undefined;
    },
    async threadMessages(threadId) {
      if (!GMAIL_ID.test(threadId)) throw new GmailReadError('gmail-read-invalid-response', 'Thread id is not a valid Gmail id');
      const messages = recordOf(await get(`/threads/${threadId}?format=metadata&metadataHeaders=From`))?.messages;
      if (messages === undefined) return [];
      if (!Array.isArray(messages)) throw new GmailReadError('gmail-read-invalid-response', 'Gmail thread response did not contain a message list');
      return messages.map((message) => {
        const record = recordOf(message);
        const id = record?.id;
        if (!record || typeof id !== 'string' || !GMAIL_ID.test(id)) {
          throw new GmailReadError('gmail-read-invalid-response', 'Gmail thread response contained an invalid message');
        }
        const labels = Array.isArray(record.labelIds)
          ? record.labelIds.filter((label): label is string => typeof label === 'string')
          : [];
        const from = headerValue(record.payload, 'From');
        const internalDate = internalDateOf(record);
        return {
          id,
          labelIds: labels,
          ...(from ? { from } : {}),
          ...(internalDate === undefined ? {} : { internalDate }),
        };
      });
    },
  };
}

async function gmailGet(url: string, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GmailReadError('gmail-read-request-failed', 'Gmail read request failed before a response was received');
  }
  if (response.status === 401) throw new GmailReadError('gmail-read-auth-unavailable', 'Gmail rejected the stored authorization', 401);
  if (response.status === 403) throw new GmailReadError('gmail-read-scope-missing', 'Gmail did not permit read-only access to the owner mailbox', 403);
  if (!response.ok) throw new GmailReadError('gmail-read-request-failed', `Gmail read request failed with HTTP ${response.status}`, response.status);
  try { return await response.json() as unknown; }
  catch { throw new GmailReadError('gmail-read-invalid-response', 'Gmail read response was not valid JSON'); }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizedAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const address = value.normalize('NFKC').trim().toLowerCase();
  return EMAIL_ADDRESS.test(address) ? address : undefined;
}

/** Extracts the bare address from a From header such as `"Professor Example" <prof@example.edu>`. */
export function senderAddress(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const bracketed = /<([^<>]+)>/.exec(from);
  return normalizedAddress(bracketed?.[1] ?? from.replace(/\([^)]*\)/g, ''));
}

function headerValue(payload: unknown, name: string): string | undefined {
  const headers = recordOf(payload)?.headers;
  if (!Array.isArray(headers)) return undefined;
  const wanted = name.toLowerCase();
  for (const header of headers) {
    const record = recordOf(header);
    if (!record || typeof record.name !== 'string' || record.name.toLowerCase() !== wanted) continue;
    return typeof record.value === 'string' ? record.value : undefined;
  }
  return undefined;
}

function internalDateOf(record: Record<string, unknown>): number | undefined {
  const raw = record.internalDate;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A reply is a non-SENT message from someone other than the owner, received after our send. */
export function findReply(
  messages: GmailThreadMessage[],
  input: { providerMessageId: string; owner: string; sentAt?: string },
): GmailThreadMessage | undefined {
  const owner = normalizedAddress(input.owner) ?? input.owner.normalize('NFKC').trim().toLowerCase();
  const sentAt = input.sentAt ? new Date(input.sentAt).getTime() : Number.NaN;
  for (const message of messages) {
    if (message.id === input.providerMessageId) continue;
    if (message.labelIds.includes('SENT')) continue;
    const sender = senderAddress(message.from);
    if (!sender || sender === owner) continue;
    // When both timestamps are known, a message that predates our send cannot be a reply to it.
    if (Number.isFinite(sentAt) && typeof message.internalDate === 'number' && message.internalDate <= sentAt) continue;
    return message;
  }
  return undefined;
}

export interface GmailReplyRecord {
  candidateId: string;
  providerMessageId: string;
  replyMessageId: string;
  repliedAt: string;
}

export interface GmailReplySyncRepositories {
  attempts: {
    listAll(): Promise<OutreachAttempt[]>;
    recordReply(input: GmailReplyRecord): Promise<boolean>;
  };
}

export interface GmailReplySyncFailure {
  candidateId: string;
  code: GmailReadFailureCode;
}

export interface GmailReplySyncResult {
  status: 'complete' | 'partial' | 'failed';
  /** Sent attempts that still need a reply decision and carry a provider message id. */
  pendingAttempts: number;
  /** Attempts whose thread was read in this run. */
  checkedAttempts: number;
  threadsChecked: number;
  repliesRecorded: number;
  /** Threads that already had a reply on record when this run tried to write it. */
  replyAlreadyRecorded: number;
  deferredAttempts: number;
  failure?: { code: GmailReadFailureCode };
  threadFailures: GmailReplySyncFailure[];
}

/** Selects sent attempts with no recorded reply; a manual `declined` decision is never revisited. */
export function pendingReplyAttempts(attempts: OutreachAttempt[]): OutreachAttempt[] {
  const seen = new Set<string>();
  const pending: OutreachAttempt[] = [];
  for (const attempt of attempts) {
    if (attempt.state !== 'sent') continue;
    if (attempt.replyStatus === 'replied' || attempt.replyStatus === 'declined') continue;
    const providerMessageId = attempt.providerMessageId;
    if (!providerMessageId || !GMAIL_ID.test(providerMessageId) || seen.has(providerMessageId)) continue;
    seen.add(providerMessageId);
    pending.push(attempt);
  }
  return pending;
}

/**
 * Confirms replies from Gmail thread headers and records them on the matching outreach attempt.
 * It never sends, deletes, labels, or reads a subject or body, and it stores only provider ids,
 * the sender-address comparison result, and the detected timestamp.
 */
export class GmailReplySyncService {
  private readonly repositories: GmailReplySyncRepositories;
  private readonly client: GmailReplySyncClient;
  private readonly maxThreadsPerRun: number;

  constructor(options: {
    repositories: GmailReplySyncRepositories;
    client?: GmailReplySyncClient;
    maxThreadsPerRun?: number;
  }) {
    this.repositories = options.repositories;
    this.client = options.client ?? createGmailReadClient();
    this.maxThreadsPerRun = options.maxThreadsPerRun ?? DEFAULT_MAX_THREADS_PER_RUN;
    if (!Number.isInteger(this.maxThreadsPerRun) || this.maxThreadsPerRun < 1) {
      throw new Error('maxThreadsPerRun must be a positive integer');
    }
  }

  async sync(now = new Date().toISOString()): Promise<GmailReplySyncResult> {
    const instant = new Date(now);
    if (Number.isNaN(instant.getTime())) throw new Error('now must be a valid date');
    const repliedAt = instant.toISOString();
    const pending = pendingReplyAttempts(await this.repositories.attempts.listAll());
    const queue = pending.slice(0, this.maxThreadsPerRun);
    const result: GmailReplySyncResult = {
      status: 'complete',
      pendingAttempts: pending.length,
      checkedAttempts: 0,
      threadsChecked: 0,
      repliesRecorded: 0,
      replyAlreadyRecorded: 0,
      deferredAttempts: pending.length - queue.length,
      threadFailures: [],
    };
    // No pending sent attempt means no mailbox access at all.
    if (queue.length === 0) return result;
    let owner: string;
    try {
      owner = await this.client.ownerAddress();
    } catch (error) {
      const code = error instanceof GmailReadError ? error.code : 'gmail-read-auth-unavailable';
      return { ...result, status: 'failed', failure: { code } };
    }
    for (const attempt of queue) {
      const providerMessageId = attempt.providerMessageId!;
      result.checkedAttempts += 1;
      try {
        const threadId = await this.client.threadIdForMessage(providerMessageId);
        if (!threadId) {
          result.threadFailures.push({ candidateId: attempt.candidateId, code: 'thread-unavailable' });
          continue;
        }
        const messages = await this.client.threadMessages(threadId);
        result.threadsChecked += 1;
        const reply = findReply(messages, {
          providerMessageId,
          owner,
          ...(attempt.sentAt ? { sentAt: attempt.sentAt } : {}),
        });
        if (!reply) continue;
        const recorded = await this.repositories.attempts.recordReply({
          candidateId: attempt.candidateId,
          providerMessageId,
          replyMessageId: reply.id,
          repliedAt,
        });
        if (recorded) result.repliesRecorded += 1;
        else result.replyAlreadyRecorded += 1;
      } catch (error) {
        const code = error instanceof GmailReadError ? error.code : 'reply-record-failed';
        // A rejected authorization or a missing scope cannot improve by retrying the next thread.
        if (code === 'gmail-read-auth-unavailable' || code === 'gmail-read-scope-missing') {
          return { ...result, status: 'failed', failure: { code } };
        }
        result.threadFailures.push({ candidateId: attempt.candidateId, code });
      }
    }
    return { ...result, status: result.threadFailures.length > 0 ? 'partial' : 'complete' };
  }
}

