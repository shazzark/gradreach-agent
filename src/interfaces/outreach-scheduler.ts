import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stdout } from 'node:process';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { GmailDeliveryService } from '../infrastructure/gmail-oauth.ts';

const POLL_INTERVAL_MS = 60_000;

export async function runOutreachScheduler(): Promise<void> {
  if (process.env.OUTREACH_SENDING_ENABLED !== 'true') {
    stdout.write('Outreach delivery is disabled. Set OUTREACH_SENDING_ENABLED=true only after account authorization and owner review.\n');
    return;
  }
  const storage = await connectMongoStorage();
  const delivery = new GmailDeliveryService({ repositories: storage.repositories });
  let stop = false;
  let wake!: () => void;
  const stopped = new Promise<void>((resolvePromise) => { wake = resolvePromise; });
  const stopScheduler = () => { stop = true; wake(); };
  process.once('SIGINT', stopScheduler);
  process.once('SIGTERM', stopScheduler);
  try {
    while (!stop) {
      try {
        const result = await delivery.deliverNext();
        if (result.status === 'delivered') stdout.write('One approved outreach message was sent and recorded.\n');
      } catch {
        process.stderr.write('Outreach scheduler cycle failed; inspect local configuration and MongoDB availability.\n');
      }
      if (!stop) await Promise.race([new Promise<void>((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS)), stopped]);
    }
  } finally {
    process.removeListener('SIGINT', stopScheduler);
    process.removeListener('SIGTERM', stopScheduler);
    await storage.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runOutreachScheduler().catch(() => {
    process.stderr.write('Could not start the outreach scheduler; check local configuration and MongoDB access.\n');
    process.exitCode = 1;
  });
}
