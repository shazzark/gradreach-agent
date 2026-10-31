import { MongoClient } from 'mongodb';

export function getEnabledMongoTestUri(input: { enabled: string | undefined; uri: string | undefined }): string | undefined {
  return input.enabled === 'true' ? input.uri : undefined;
}

const EXPECTED_TEST_DATABASE = 'gradreach_test';

/** Validates through the MongoDB driver without connecting or echoing the supplied URI. */
export function assertMongoTestUri(uri: string): void {
  let databaseName: string;
  try {
    databaseName = new MongoClient(uri).options.dbName;
  } catch {
    throw new TypeError('MONGODB_TEST_URI is malformed; URI details are hidden.');
  }

  if (databaseName !== EXPECTED_TEST_DATABASE) {
    throw new Error(`MONGODB_TEST_URI must target ${EXPECTED_TEST_DATABASE}; URI details are hidden.`);
  }
}
