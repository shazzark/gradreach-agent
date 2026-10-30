import test from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from 'mongodb';
import { assertDiscoveryCollectionsMigrated, DiscoveryCollectionMigrationError, migrateDiscoveryCollections } from '../src/infrastructure/discovery-collection-migration.ts';
import { createPhase2Indexes, createRepositories } from '../src/infrastructure/mongo-storage.ts';

interface MemoryCollection {
  documents: Array<{ _id: string; value: string }>;
  indexes: Array<{ name: string; key: Record<string, number> }>;
}

function memoryDatabase(initial: Record<string, MemoryCollection> = {}) {
  const collections = new Map(Object.entries(initial));
  const renames: Array<{ from: string; to: string; dropTarget: boolean | undefined }> = [];
  const indexCreations: string[] = [];
  const db = {
    listCollections() {
      return { toArray: async () => [...collections.keys()].map((name) => ({ name })) };
    },
    collection(name: string) {
      return {
        async rename(target: string, options?: { dropTarget?: boolean }) {
          renames.push({ from: name, to: target, dropTarget: options?.dropTarget });
          if (collections.has(target)) throw new Error('Target exists');
          const source = collections.get(name);
          if (!source) throw new Error('Source is missing');
          collections.set(target, source);
          collections.delete(name);
          return this;
        },
        async createIndex() { indexCreations.push(name); return 'synthetic-index'; },
      };
    },
  };
  return { db: db as unknown as Db, collections, renames, indexCreations };
}

test('migration renames both legacy collections in place and is idempotent', async () => {
  const leads: MemoryCollection = {
    documents: [{ _id: 'candidate-id-1', value: 'original document' }],
    indexes: [{ name: 'unique_normalized_candidate_email', key: { normalizedEmail: 1 } }],
  };
  const triage: MemoryCollection = {
    documents: [{ _id: 'triage-id-1', value: 'original recommendation' }],
    indexes: [{ name: '_id_', key: { _id: 1 } }],
  };
  const memory = memoryDatabase({ professor_candidates: leads, candidate_evidence_triage: triage });

  assert.deepEqual(await migrateDiscoveryCollections(memory.db), [
    'professor_candidates -> discovery_leads',
    'candidate_evidence_triage -> lead_triage_recommendations',
  ]);
  assert.equal(memory.collections.get('discovery_leads'), leads);
  assert.equal(memory.collections.get('lead_triage_recommendations'), triage);
  assert.deepEqual(leads.documents, [{ _id: 'candidate-id-1', value: 'original document' }]);
  assert.deepEqual(leads.indexes, [{ name: 'unique_normalized_candidate_email', key: { normalizedEmail: 1 } }]);
  assert.ok(memory.renames.every((rename) => rename.dropTarget === false));

  assert.deepEqual(await migrateDiscoveryCollections(memory.db), []);
  assert.equal(memory.renames.length, 2);
});

test('migration refuses existing old and new names before renaming either collection', async () => {
  const memory = memoryDatabase({
    professor_candidates: { documents: [], indexes: [] },
    discovery_leads: { documents: [{ _id: 'keep', value: 'do not replace' }], indexes: [] },
    candidate_evidence_triage: { documents: [], indexes: [] },
  });
  await assert.rejects(migrateDiscoveryCollections(memory.db), DiscoveryCollectionMigrationError);
  assert.equal(memory.renames.length, 0);
  assert.equal(memory.collections.has('discovery_leads'), true);
});

test('migration resumes safely after only one collection has already been renamed', async () => {
  const leads: MemoryCollection = { documents: [{ _id: 'keep-id', value: 'keep lead' }], indexes: [] };
  const memory = memoryDatabase({
    discovery_leads: leads,
    candidate_evidence_triage: { documents: [{ _id: 'keep-triage-id', value: 'keep recommendation' }], indexes: [] },
  });
  assert.deepEqual(await migrateDiscoveryCollections(memory.db), ['candidate_evidence_triage -> lead_triage_recommendations']);
  assert.equal(memory.collections.get('discovery_leads'), leads);
  assert.deepEqual(memory.collections.get('lead_triage_recommendations')?.documents, [{ _id: 'keep-triage-id', value: 'keep recommendation' }]);
  await assert.doesNotReject(assertDiscoveryCollectionsMigrated(memory.db));
});

test('application storage guard blocks legacy collections but permits fresh or fully migrated databases', async () => {
  const legacy = memoryDatabase({ professor_candidates: { documents: [], indexes: [] } });
  await assert.rejects(assertDiscoveryCollectionsMigrated(legacy.db), /db:migrate-discovery/);

  const migrated = memoryDatabase({ discovery_leads: { documents: [], indexes: [] }, lead_triage_recommendations: { documents: [], indexes: [] } });
  await assert.doesNotReject(assertDiscoveryCollectionsMigrated(migrated.db));

  const fresh = memoryDatabase();
  await assert.doesNotReject(assertDiscoveryCollectionsMigrated(fresh.db));
});

test('index creation blocks before writing indexes when legacy collections remain', async () => {
  const memory = memoryDatabase({ professor_candidates: { documents: [], indexes: [] } });
  await assert.rejects(createPhase2Indexes(memory.db), /db:migrate-discovery/);
  assert.deepEqual(memory.indexCreations, []);
});

test('repositories and candidate indexes use the replacement collection name', async () => {
  const requested: string[] = [];
  const db = { collection(name: string) { requested.push(name); return {} as never; } } as unknown as Db;
  createRepositories(db);
  assert.ok(requested.includes('discovery_leads'));
  assert.ok(requested.includes('lead_triage_recommendations'));

  const memory = memoryDatabase({ discovery_leads: { documents: [], indexes: [] } });
  await createPhase2Indexes(memory.db);
  assert.deepEqual(memory.indexCreations, ['discovery_leads', 'outreach_attempts', 'outreach_attempts']);
});
