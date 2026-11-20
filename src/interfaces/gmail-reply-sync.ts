import '../infrastructure/local-env.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stdout } from 'node:process';
import { connectMongoStorage, type ConnectedMongoStorage } from '../infrastructure/mongo-storage.ts';
import { GmailReplySyncService, createGmailReadClient, type GmailReplySyncResult } from '../infrastructure/gmail-reply-sync.ts';

/** One read-only pass over the threads of sent outreach; prints aggregate counts and no message content. */
export async function runGmailReplySync(connect: () => Promise<ConnectedMongoStorage> = connectMongoStorage): Promise<GmailReplySyncResult> {
  const storage = await connect();
  try {
    const result = await new GmailReplySyncService({
      repositories: { attempts: storage.repositories.attempts },
      client: createGmailReadClient(),
    }).sync();
    stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'complete') process.exitCode = 1;
    return result;
  } finally {
    await storage.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runGmailReplySync().catch(() => {
    process.stderr.write('Reply sync did not complete. Check Gmail authorization (npm run gmail:connect) and MongoDB access.\n');
    process.exitCode = 1;
  });
}
