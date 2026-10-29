import './local-env.ts';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { OutreachAttempt, ProfessorCandidate, SchedulerControl } from '../domain/outreach-queue.ts';
import { candidateReadinessIssue } from '../domain/outreach-queue.ts';
import { validateOutreachDraft, type OutreachDraft } from '../application/outreach-draft.ts';
import { draftFingerprint } from '../application/outreach-review.ts';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const execFileAsync = promisify(execFile);

interface GmailTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type: 'Bearer';
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function saveTokens(path: string, tokens: GmailTokenSet): Promise<void> {
  const target = resolve(path);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    // Restrict the temporary file before writing any access or refresh token bytes.
    await writeFile(temporary, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await restrictToCurrentUser(temporary);
    await writeFile(temporary, `${JSON.stringify(tokens)}\n`, 'utf8');
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

async function restrictToCurrentUser(path: string): Promise<void> {
  if (process.platform === 'win32') {
    let username = '';
    try { username = (await execFileAsync('whoami.exe', [], { windowsHide: true })).stdout.trim(); } catch { /* fail closed below */ }
    if (!username || /[\r\n]/.test(username)) throw new Error('Cannot identify the current Windows user to protect the Gmail token file');
    try { await execFileAsync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${username}:(F)`], { windowsHide: true }); }
    catch { throw new Error('Could not restrict Gmail token file access to the current Windows user'); }
  } else await chmod(path, 0o600);
}

async function readTokens(path: string): Promise<GmailTokenSet> {
  try {
    const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as Partial<GmailTokenSet>;
    if (typeof parsed.access_token !== 'string' || typeof parsed.expires_at !== 'number' || parsed.token_type !== 'Bearer') throw new Error();
    if (parsed.scope !== GMAIL_SEND_SCOPE) throw new Error();
    return parsed as GmailTokenSet;
  } catch {
    throw new Error('Gmail token file is missing or invalid; authorize Gmail again');
  }
}

/** Starts a loopback OAuth callback using state and PKCE; caller opens the returned URL locally. */
export async function beginGmailAuthorization(options: {
  clientId?: string;
  clientSecret?: string;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ authorizationUrl: string; complete: Promise<void>; close(): Promise<void> }> {
  const clientId = options.clientId ?? requiredEnv('EMAIL_PROVIDER_CLIENT_ID');
  const clientSecret = options.clientSecret ?? requiredEnv('EMAIL_PROVIDER_CLIENT_SECRET');
  const tokenPath = options.tokenPath ?? process.env.EMAIL_PROVIDER_TOKEN_PATH ?? 'private-data/gmail-token.json';
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let callbackResolve!: (code: string) => void;
  let callbackReject!: (error: Error) => void;
  const callback = new Promise<string>((resolvePromise, rejectPromise) => { callbackResolve = resolvePromise; callbackReject = rejectPromise; });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const returnedState = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code');
    if (url.pathname !== '/oauth2callback' || !safeEqual(returnedState, state) || !code) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Authorization was not accepted. Return to GradReach and try again.');
      callbackReject(new Error('Gmail OAuth callback state was invalid or authorization was denied'));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Gmail authorization completed. You can close this tab.');
    callbackResolve(code);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Could not start local Gmail OAuth callback'); }
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GMAIL_SEND_SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  const complete = (async () => {
    try {
      const code = await callback;
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Gmail OAuth token exchange failed with HTTP ${response.status}`);
      const payload = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown };
      if (typeof payload.access_token !== 'string' || typeof payload.expires_in !== 'number' || payload.token_type !== 'Bearer' || payload.scope !== GMAIL_SEND_SCOPE) {
        throw new Error('Gmail OAuth response did not grant the required send-only scope');
      }
      await saveTokens(tokenPath, {
        access_token: payload.access_token,
        ...(typeof payload.refresh_token === 'string' ? { refresh_token: payload.refresh_token } : {}),
        expires_at: Date.now() + payload.expires_in * 1000,
        scope: payload.scope,
        token_type: 'Bearer',
      });
    } finally { await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())); }
  })();
  return { authorizationUrl: authorizationUrl.toString(), complete, close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())) };
}

async function accessToken(path: string, clientId: string, clientSecret: string, fetchImpl: typeof fetch): Promise<string> {
  const tokens = await readTokens(path);
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('Gmail authorization expired; authorize Gmail again');
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Gmail token refresh failed with HTTP ${response.status}`);
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== 'string' || typeof payload.expires_in !== 'number') throw new Error('Gmail token refresh response was invalid');
  const refreshed = { ...tokens, access_token: payload.access_token, expires_at: Date.now() + payload.expires_in * 1000 };
  await saveTokens(path, refreshed);
  return refreshed.access_token;
}

interface GmailMessage {
  to: string;
  subject: string;
  body: string;
}

export class GmailDeliveryError extends Error {
  readonly code: string;
  readonly certainty: 'not-sent' | 'unknown';
  readonly retryable: boolean;

  constructor(code: string, certainty: 'not-sent' | 'unknown', retryable: boolean) {
    super(code);
    this.code = code;
    this.certainty = certainty;
    this.retryable = retryable;
    this.name = 'GmailDeliveryError';
  }
}

async function sendGmailMessage(message: GmailMessage): Promise<string> {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(message.to) || /[\r\n]/.test(message.to + message.subject) || !message.subject.trim() || !message.body.trim()) {
    throw new GmailDeliveryError('invalid-message', 'not-sent', false);
  }
  const path = process.env.EMAIL_PROVIDER_TOKEN_PATH ?? 'private-data/gmail-token.json';
  const clientId = requiredEnv('EMAIL_PROVIDER_CLIENT_ID');
  const clientSecret = requiredEnv('EMAIL_PROVIDER_CLIENT_SECRET');
  let token: string;
  try { token = await accessToken(path, clientId, clientSecret, fetch); }
  catch { throw new GmailDeliveryError('gmail-auth-unavailable', 'not-sent', true); }
  const subject = `=?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`;
  const mime = `To: ${message.to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${message.body.replace(/\r?\n/g, '\r\n')}`;
  let response: Response;
  try {
    response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }), signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new GmailDeliveryError('gmail-transport-outcome-unknown', 'unknown', false); }
  if (!response.ok) {
    if (response.status === 429) throw new GmailDeliveryError('gmail-rate-limited', 'not-sent', true);
    if (response.status >= 400 && response.status < 500) throw new GmailDeliveryError(`gmail-rejected-${response.status}`, 'not-sent', false);
    throw new GmailDeliveryError(`gmail-server-${response.status}-outcome-unknown`, 'unknown', false);
  }
  let payload: { id?: unknown };
  try { payload = await response.json() as { id?: unknown }; }
  catch { throw new GmailDeliveryError('gmail-response-outcome-unknown', 'unknown', false); }
  if (typeof payload.id !== 'string') throw new GmailDeliveryError('gmail-message-id-missing-outcome-unknown', 'unknown', false);
  return payload.id;
}

export interface GmailDeliveryResult {
  status: 'disabled' | 'paused' | 'empty' | 'delivered' | 'daily-cap' | 'failed' | 'uncertain';
  candidateId?: string;
  attemptCount?: number;
  recoveredUncertain?: number;
}

interface GmailDeliveryDependencies {
  repositories: {
    attempts: {
      listAll(): Promise<OutreachAttempt[]>;
      claimForDelivery(attempt: OutreachAttempt, now: string, maxAttempts: number): Promise<OutreachAttempt | undefined>;
      updateDelivery(attempt: OutreachAttempt): Promise<boolean>;
      releaseClaim(attempt: OutreachAttempt): Promise<void>;
      rejectQueued(attempt: OutreachAttempt, failureCode: string): Promise<void>;
      recoverStaleSending(before: string): Promise<number>;
    };
    candidates: {
      get(candidateId: string): Promise<ProfessorCandidate | undefined>;
      markSent(candidateId: string): Promise<boolean>;
    };
    schedulerControl: {
      get(): Promise<SchedulerControl | undefined>;
      reserveDailySend(now: string): Promise<boolean>;
    };
  };
  /** Test seam for deterministic provider fixtures; production defaults to Gmail. */
  send?: (message: GmailMessage) => Promise<string>;
}

/** Delivers one due, explicitly approved draft through atomic audit and local-day reservations. */
export class GmailDeliveryService {
  private readonly repositories: GmailDeliveryDependencies['repositories'];
  private readonly send: (message: GmailMessage) => Promise<string>;
  private readonly sendingEnabled: boolean;
  private readonly maxAttempts = 3;
  private readonly staleAfterMs = 5 * 60 * 1000;

  constructor(options: GmailDeliveryDependencies & { sendingEnabled?: boolean }) {
    this.repositories = options.repositories;
    this.send = options.send ?? sendGmailMessage;
    this.sendingEnabled = options.sendingEnabled ?? process.env.OUTREACH_SENDING_ENABLED === 'true';
  }

  async deliverNext(now = new Date().toISOString()): Promise<GmailDeliveryResult> {
    if (!this.sendingEnabled) return { status: 'disabled' };
    const instant = new Date(now);
    if (Number.isNaN(instant.getTime())) throw new Error('now must be a valid date');
    const recoveredUncertain = await this.repositories.attempts.recoverStaleSending(new Date(instant.getTime() - this.staleAfterMs).toISOString());
    const control = await this.repositories.schedulerControl.get();
    if (!control || control.paused) return { status: 'paused', recoveredUncertain };
    const attempts = await this.repositories.attempts.listAll();
    const due = attempts.filter((attempt) =>
      (attempt.state === 'queued' || (attempt.state === 'failed' && attempt.nextAttemptAt && new Date(attempt.nextAttemptAt) <= instant)) &&
      new Date(attempt.scheduledFor) <= instant,
    ).sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
    if (!due.length) return { status: 'empty', recoveredUncertain };

    for (const pending of due) {
      const candidate = await this.repositories.candidates.get(pending.candidateId);
      const invalid = this.validateApprovedDelivery(candidate, pending, attempts);
      if (invalid) {
        await this.repositories.attempts.rejectQueued(pending, invalid);
        continue;
      }
      const claimed = await this.repositories.attempts.claimForDelivery(pending, instant.toISOString(), this.maxAttempts);
      if (!claimed) continue;
      if (!await this.repositories.schedulerControl.reserveDailySend(instant.toISOString())) {
        await this.repositories.attempts.releaseClaim(claimed);
        const latest = await this.repositories.schedulerControl.get();
        return { status: latest?.paused ? 'paused' : 'daily-cap', recoveredUncertain };
      }
      const draft = JSON.parse(candidate!.personalizedDraft!) as OutreachDraft;
      try {
        const providerMessageId = await this.send({ to: draft.recipientEmail, subject: draft.subject, body: draft.body });
        const sent: OutreachAttempt = {
          ...claimed, state: 'sent', sentAt: instant.toISOString(), providerMessageId,
        };
        await this.repositories.attempts.updateDelivery(sent);
        await this.repositories.candidates.markSent(candidate!.id);
        return { status: 'delivered', candidateId: candidate!.id, attemptCount: sent.deliveryAttempts ?? 1, recoveredUncertain };
      } catch (error) {
        const failure = error instanceof GmailDeliveryError ? error : new GmailDeliveryError('provider-outcome-unknown', 'unknown', false);
        const attemptCount = claimed.deliveryAttempts ?? 1;
        const nextAttemptAt = failure.certainty === 'not-sent' && failure.retryable && attemptCount < this.maxAttempts
          ? new Date(instant.getTime() + Math.min(60_000 * 2 ** attemptCount, 15 * 60_000)).toISOString()
          : undefined;
        const failed: OutreachAttempt = {
          ...claimed,
          state: failure.certainty === 'unknown' ? 'uncertain' : 'failed',
          failureCode: failure.code,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
        };
        await this.repositories.attempts.updateDelivery(failed);
        return { status: failed.state === 'uncertain' ? 'uncertain' : 'failed', candidateId: candidate!.id, attemptCount, recoveredUncertain };
      }
    }
    return { status: 'empty', recoveredUncertain };
  }

  private validateApprovedDelivery(candidate: ProfessorCandidate | undefined, attempt: OutreachAttempt, attempts: OutreachAttempt[]): string | undefined {
    if (!candidate) return 'candidate-missing';
    const readiness = candidateReadinessIssue(candidate);
    if (readiness) return `candidate-not-approved:${readiness.replace(/\s+/g, '-')}`;
    if (!candidate.approvedAt || !candidate.approvedDraftHash || !candidate.personalizedDraft) return 'draft-approval-record-missing';
    let parsed: unknown;
    try { parsed = JSON.parse(candidate.personalizedDraft) as unknown; }
    catch { return 'approved-draft-invalid'; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'approved-draft-invalid';
    const draft = parsed as OutreachDraft;
    if (['candidateId', 'recipientEmail', 'subject', 'body', 'personalizationSourceUrl', 'personalizationExcerpt', 'generatedAt']
      .some((field) => typeof (draft as unknown as Record<string, unknown>)[field] !== 'string')) return 'approved-draft-invalid';
    if (draftFingerprint(draft) !== candidate.approvedDraftHash) return 'approved-draft-changed';
    if (draft.candidateId !== candidate.id || draft.recipientEmail.trim().toLowerCase() !== attempt.recipientEmail.trim().toLowerCase()) return 'approved-draft-recipient-mismatch';
    if (candidate.officialEmail?.trim().toLowerCase() !== attempt.recipientEmail.trim().toLowerCase()) return 'approved-contact-mismatch';
    const evidence = candidate.discoveryEvidence ?? [];
    if (!evidence.some((item) => item.kind === 'professor-profile' && item.verification === 'reviewed' && item.sourceUrl === draft.personalizationSourceUrl && item.excerpt.includes(draft.personalizationExcerpt))) return 'approved-profile-evidence-missing';
    if (!candidate.emailSourceUrl || !evidence.some((item) => item.kind === 'contact' && item.verification === 'reviewed' && item.sourceUrl === candidate.emailSourceUrl)) return 'approved-contact-evidence-missing';
    if (!candidate.programUrl || !evidence.some((item) => item.kind === 'program' && item.verification === 'reviewed' && item.sourceUrl === candidate.programUrl)) return 'approved-program-evidence-missing';
    if (!candidate.fitSummary?.includes(draft.personalizationExcerpt) || !candidate.fitSummary.includes(draft.personalizationSourceUrl)) return 'approved-fit-note-mismatch';
    const attemptId = `${attempt.candidateId}:${new Date(attempt.scheduledFor).toISOString()}`;
    const prior = attempts.filter((item) => `${item.candidateId}:${new Date(item.scheduledFor).toISOString()}` !== attemptId);
    const draftIssues = validateOutreachDraft(draft, prior);
    if (draftIssues.length) return `approved-draft-review-invalid:${draftIssues[0]!.replace(/\s+/g, '-')}`;
    return undefined;
  }
}
