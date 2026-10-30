import type { Db } from 'mongodb';

export const DISCOVERY_COLLECTION_RENAMES = [
  { from: 'professor_candidates', to: 'discovery_leads' },
  { from: 'candidate_evidence_triage', to: 'lead_triage_recommendations' },
] as const;

export class DiscoveryCollectionMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryCollectionMigrationError';
  }
}

async function collectionNames(db: Db): Promise<Set<string>> {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  return new Set(collections.map((collection) => collection.name));
}

/** Blocks application storage while any legacy collection still exists. */
export async function assertDiscoveryCollectionsMigrated(db: Db): Promise<void> {
  const names = await collectionNames(db);
  const collisions = DISCOVERY_COLLECTION_RENAMES.filter(({ from, to }) => names.has(from) && names.has(to));
  if (collisions.length) {
    throw new DiscoveryCollectionMigrationError(
      'Both legacy and replacement discovery collections exist; reconcile them before using GradReach storage.',
    );
  }
  if (DISCOVERY_COLLECTION_RENAMES.some(({ from }) => names.has(from))) {
    throw new DiscoveryCollectionMigrationError(
      'Legacy discovery collections must be renamed with npm run db:migrate-discovery before using GradReach storage.',
    );
  }
}

/** Renames legacy collections in place; retries safely finish a partial migration without replacing targets. */
export async function migrateDiscoveryCollections(db: Db): Promise<string[]> {
  let names = await collectionNames(db);
  const collisions = DISCOVERY_COLLECTION_RENAMES.filter(({ from, to }) => names.has(from) && names.has(to));
  if (collisions.length) {
    throw new DiscoveryCollectionMigrationError(
      `Migration stopped because both collection names exist for: ${collisions.map(({ from, to }) => `${from} and ${to}`).join('; ')}. No collection was renamed.`,
    );
  }

  const renamed: string[] = [];
  for (const { from, to } of DISCOVERY_COLLECTION_RENAMES) {
    if (!names.has(from)) continue;
    await db.collection(from).rename(to, { dropTarget: false });
    renamed.push(`${from} -> ${to}`);
    names = await collectionNames(db);
  }
  return renamed;
}
