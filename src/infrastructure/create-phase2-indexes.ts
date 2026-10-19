import { MongoClient } from 'mongodb';
import { createPhase2Indexes } from './mongo-storage.ts';

const uri = process.env.MONGODB_URI;
if (!uri?.trim()) {
  throw new Error('MONGODB_URI must be configured before creating MongoDB indexes');
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const databaseName = process.env.MONGODB_DATABASE;
  const db = databaseName ? client.db(databaseName) : client.db();
  await createPhase2Indexes(db);
  process.stdout.write('GradReach Phase 2 indexes are ready.\n');
} catch {
  process.stderr.write('Could not create GradReach Phase 2 indexes; confirm the MongoDB URI and access permissions.\n');
  process.exitCode = 1;
} finally {
  await client.close();
}
