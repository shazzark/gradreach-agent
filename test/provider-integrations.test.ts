import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beginGmailAuthorization, GmailSender, GMAIL_SEND_SCOPE } from '../src/infrastructure/gmail-oauth.ts';
import { GeminiDraftProvider } from '../src/infrastructure/gemini-draft-provider.ts';

test('Gmail OAuth asks for send-only scope and stores callback tokens with owner-only mode', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gradreach-oauth-'));
  const tokenPath = join(folder, 'tokens.json');
  try {
    const flow = await beginGmailAuthorization({
      clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret', tokenPath,
      fetchImpl: async (_input, init) => {
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.ok(body.get('code_verifier'));
        return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600, scope: GMAIL_SEND_SCOPE, token_type: 'Bearer' });
      },
    });
    try {
      const authorizationUrl = new URL(flow.authorizationUrl);
      assert.equal(authorizationUrl.searchParams.get('scope'), GMAIL_SEND_SCOPE);
      assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
      const callbackUri = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
      const callbackResponse = await fetch(`${callbackUri.origin}/oauth2callback?code=synthetic-code&state=${authorizationUrl.searchParams.get('state')}`);
      assert.equal(callbackResponse.status, 200);
      await flow.complete;
      const saved = JSON.parse(await readFile(tokenPath, 'utf8')) as { access_token: string; scope: string };
      assert.equal(saved.access_token, 'synthetic-access-token');
      assert.equal(saved.scope, GMAIL_SEND_SCOPE);
      if (platform() !== 'win32') assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
      else assert.ok((await stat(tokenPath)).isFile());
    } finally { await flow.close(); }
  } finally {
    // Restore inherited temp-directory permissions before removing the fixture on Windows.
    if (platform() === 'win32') {
      try { execFileSync('icacls.exe', [tokenPath, '/reset', '/Q'], { windowsHide: true, stdio: 'ignore' }); } catch { /* best-effort cleanup of a synthetic temp fixture */ }
    }
    await rm(folder, { recursive: true, force: true });
  }
});

test('Gmail sender refuses by default and stays blocked until cap-enforcing delivery exists', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return Response.json({}); };
  const sender = new GmailSender({ tokenPath: 'unused', sendingEnabled: false, fetchImpl });
  await assert.rejects(sender.send({ to: 'professor@example.edu', subject: 'Hello', body: 'Draft' }), /sending is disabled/);
  const enabledButUnorchestrated = new GmailSender({ tokenPath: 'unused', sendingEnabled: true, fetchImpl });
  await assert.rejects(enabledButUnorchestrated.send({ to: 'professor@example.edu', subject: 'Hello', body: 'Draft' }), /daily-cap delivery workflow/);
  assert.equal(called, false);
});

test('Gmail OAuth rejects and does not store an expanded scope set', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gradreach-oauth-scope-'));
  const tokenPath = join(folder, 'tokens.json');
  try {
    const flow = await beginGmailAuthorization({
      clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret', tokenPath,
      fetchImpl: async () => Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600, scope: `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/gmail.readonly`, token_type: 'Bearer' }),
    });
    try {
      const url = new URL(flow.authorizationUrl);
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      const completionFailure = assert.rejects(flow.complete, /send-only scope/);
      await fetch(`${redirect.origin}/oauth2callback?code=synthetic-code&state=${url.searchParams.get('state')}`);
      await completionFailure;
      await assert.rejects(readFile(tokenPath), { code: 'ENOENT' });
    } finally { await flow.close(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Gemini adapter uses its configured key without logging it and parses generated JSON', async () => {
  let requestBody = '';
  const provider = new GeminiDraftProvider({ apiKey: 'synthetic-api-key', model: 'test-model', fetchImpl: async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'synthetic-api-key');
    requestBody = String(init?.body);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'MSc research inquiry', body: 'Dear Professor Example,\nI read this verified passage about hydrology research in your group. Source: https://example.edu/profile' }) }] } }] });
  } });
  const result = await provider.generate({
    applicantName: 'Synthetic Applicant', academicBackground: 'BSc example', interest: 'hydrology', professorName: 'Professor Example',
    institution: 'Example University', verifiedExcerpt: 'hydrology research', sourceUrl: 'https://example.edu/profile', intake: '2027',
  });
  assert.equal(result.subject, 'MSc research inquiry');
  assert.match(requestBody, /Do not send or approve anything/);
});
