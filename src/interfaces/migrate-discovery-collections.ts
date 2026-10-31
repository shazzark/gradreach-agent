import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import '../infrastructure/local-env.ts';
import { MongoClient } from 'mongodb';
import { migrateDiscoveryCollections, DiscoveryCollectionMigrationError } from '../infrastructure/discovery-collection-migration.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

async function run(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri?.trim()) {
    process.stderr.write('MONGODB_URI must be configured before migrating discovery collections.\n');
    process.exitCode = 1;
    return;
  }

  const client = new MongoClient(uri);
  let stage = 'mongodb_connect';
  try {
    await client.connect();
    const databaseName = process.env.MONGODB_DATABASE;
    const db = databaseName ? client.db(databaseName) : client.db();
    stage = 'discovery_collection_rename';
    const renamed = await migrateDiscoveryCollections(db);
    process.stdout.write(renamed.length
      ? `Renamed discovery collections: ${renamed.join(', ')}.\n`
      : 'No legacy discovery collections required renaming.\n');
  } catch (error) {
    if (error instanceof DiscoveryCollectionMigrationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      const failure = safeFailureRecord(error);
      process.stderr.write(`Discovery collection migration failed at ${stage}: ${failure.kind}: ${failure.message}${failure.causeCode ? ` (${failure.causeCode})` : ''}\n`);
    }
    process.exitCode = 1;
  } finally {
    try { await client.close(); } catch { /* Avoid exposing raw driver errors during shutdown. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
