import './local-env.ts';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import type { Server } from 'node:http';

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

export interface GmailMessage {
  to: string;
  subject: string;
  body: string;
}

/** Gmail API send adapter. Sending remains inert unless both gates are explicitly open. */
export class GmailSender {
  private readonly options: { tokenPath?: string; clientId?: string; clientSecret?: string; sendingEnabled?: boolean; fetchImpl?: typeof fetch };

  constructor(options: { tokenPath?: string; clientId?: string; clientSecret?: string; sendingEnabled?: boolean; fetchImpl?: typeof fetch } = {}) {
    this.options = options;
  }

  async send(message: GmailMessage): Promise<string> {
    if ((this.options.sendingEnabled ?? process.env.OUTREACH_SENDING_ENABLED) !== true && (this.options.sendingEnabled ?? process.env.OUTREACH_SENDING_ENABLED) !== 'true') {
      throw new Error('Email sending is disabled; set OUTREACH_SENDING_ENABLED=true only after explicit review and approval');
    }
    throw new Error('Gmail delivery is unavailable until the approved, pause-aware daily-cap delivery workflow is implemented');
  }

  async #sendApprovedMessage(message: GmailMessage): Promise<string> {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(message.to) || /[\r\n]/.test(message.to + message.subject) || !message.subject.trim() || !message.body.trim()) {
      throw new Error('Gmail message fields are invalid');
    }
    const path = this.options.tokenPath ?? process.env.EMAIL_PROVIDER_TOKEN_PATH ?? 'private-data/gmail-token.json';
    const clientId = this.options.clientId ?? requiredEnv('EMAIL_PROVIDER_CLIENT_ID');
    const clientSecret = this.options.clientSecret ?? requiredEnv('EMAIL_PROVIDER_CLIENT_SECRET');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const token = await accessToken(path, clientId, clientSecret, fetchImpl);
    const subject = `=?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`;
    const mime = `To: ${message.to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${message.body.replace(/\r?\n/g, '\r\n')}`;
    const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Gmail send failed with HTTP ${response.status}`);
    const payload = await response.json() as { id?: unknown };
    if (typeof payload.id !== 'string') throw new Error('Gmail send response did not include a message ID');
    return payload.id;
  }
}
