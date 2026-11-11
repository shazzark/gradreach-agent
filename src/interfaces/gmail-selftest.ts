import '../infrastructure/local-env.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { sendGmailSelfTest } from '../infrastructure/gmail-oauth.ts';

export async function runGmailSelfTest(): Promise<void> {
  const result = await sendGmailSelfTest();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'delivered') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runGmailSelfTest();
