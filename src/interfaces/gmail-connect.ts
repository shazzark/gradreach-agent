import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { beginGmailAuthorization } from '../infrastructure/gmail-oauth.ts';

export async function connectGmail(): Promise<void> {
  const authorization = await beginGmailAuthorization();
  process.stdout.write(`Open this URL in your browser to authorize Gmail sending and read-only reply detection:\n${authorization.authorizationUrl}\n`);
  process.stdout.write('Only message headers are read back, and no email is sent by this authorization.\n');
  try { await authorization.complete; process.stdout.write('Gmail token saved to the configured private token path.\n'); }
  catch { process.stderr.write('Gmail authorization failed. No token was saved.\n'); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await connectGmail();
