import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Db, Document } from 'mongodb';
import { canonicalizeOpportunityIdentity, type OpportunityKind, type ProgramRecord } from '../domain/program-assessment.ts';

const LEGACY_COLLECTION = 'programs';
const OPPORTUNITY_COLLECTION = 'opportunities';
const OPPORTUNITY_TYPES: readonly OpportunityKind[] = ['msc_program', 'scholarship', 'company_graduate_program'];

export class OpportunityCollectionMigrationError extends Error {
  constructor(message: string) { super(message); this.name = 'OpportunityCollectionMigrationError'; }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function canonicalSource(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function opportunityIdentityHash(opportunity: ProgramRecord): string {
  return hash(canonicalizeOpportunityIdentity(opportunity));
}

export function opportunitySourceHash(opportunity: ProgramRecord): string | undefined {
  return opportunity.sourceEvidence?.sourceUrl ? hash(canonicalSource(opportunity.sourceEvidence.sourceUrl)) : undefined;
}

async function names(db: Db): Promise<Set<string>> {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name));
}

/** Startup guard prevents silently leaving legacy records behind while reads use the new collection. */
export async function assertOpportunityCollectionMigrated(db: Db): Promise<void> {
  if ((await names(db)).has(LEGACY_COLLECTION)) {
    throw new OpportunityCollectionMigrationError('The legacy programs collection exists. Review its records and migrate them before using the opportunities repository.');
  }
}

function migrateDocument(document: Document): Document {
  const legacy = document.program as Record<string, unknown> | undefined;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || typeof legacy.id !== 'string' || !legacy.id.trim()) {
    throw new OpportunityCollectionMigrationError('A legacy program record has an invalid shape; no source record was removed.');
  }
  const type = legacy.type ?? legacy.kind ?? 'msc_program';
  if (!OPPORTUNITY_TYPES.includes(type as OpportunityKind)) {
    throw new OpportunityCollectionMigrationError('A legacy program has an unsupported type; no source record was removed.');
  }
  const opportunity = { ...legacy, type } as unknown as ProgramRecord;
  delete (opportunity as ProgramRecord & { kind?: OpportunityKind }).kind;
  if (!opportunity.institution?.trim() || !opportunity.name?.trim() || !opportunity.country?.trim()) {
    throw new OpportunityCollectionMigrationError('A legacy opportunity is missing identity fields; no source record was removed.');
  }
  const identityHash = opportunityIdentityHash(opportunity);
  const sourceHash = opportunitySourceHash(opportunity);
  const migrated: Document = { ...document, opportunity, canonicalIdentityHash: identityHash };
  delete migrated.program;
  if (sourceHash) migrated.canonicalSourceHash = sourceHash;
  return migrated;
}

/** Copies and verifies one legacy record before removing it, so reruns safely resume partial migrations. */
export async function migrateOpportunityCollection(db: Db): Promise<{ migrated: number; alreadyPresent: number }> {
  const initialNames = await names(db);
  if (!initialNames.has(LEGACY_COLLECTION)) return { migrated: 0, alreadyPresent: 0 };
  const source = db.collection<Document>(LEGACY_COLLECTION);
  const target = db.collection<Document>(OPPORTUNITY_COLLECTION);
  let migrated = 0;
  let alreadyPresent = 0;
  const cursor = source.find().sort({ _id: 1 });

  for await (const legacyDocument of cursor) {
    const document = migrateDocument(legacyDocument);
    const identityClaim = await target.findOne({ canonicalIdentityClaimHash: document.canonicalIdentityHash }, { projection: { _id: 1 } });
    if (!identityClaim || identityClaim._id === legacyDocument._id) {
      document.canonicalIdentityClaimHash = document.canonicalIdentityHash;
    }
    if (document.canonicalSourceHash) {
      const sourceClaim = await target.findOne({ canonicalSourceClaimHash: document.canonicalSourceHash }, { projection: { _id: 1 } });
      if (!sourceClaim || sourceClaim._id === legacyDocument._id) document.canonicalSourceClaimHash = document.canonicalSourceHash;
    }

    const existing = await target.findOne({ _id: legacyDocument._id });
    if (existing) {
      if (!isDeepStrictEqual(existing, document)) {
        throw new OpportunityCollectionMigrationError('A target opportunity with the same ID has different contents; both records were preserved for review.');
      }
      alreadyPresent++;
    } else {
      try { await target.insertOne(document); }
      catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error;
        const duplicateId = await target.findOne({ _id: legacyDocument._id });
        if (!duplicateId || !isDeepStrictEqual(duplicateId, document)) {
          throw new OpportunityCollectionMigrationError('A conflicting opportunity claim prevented migration; the source record was retained.');
        }
        alreadyPresent++;
      }
      migrated++;
    }
    const removed = await source.deleteOne({ _id: legacyDocument._id });
    if (removed.deletedCount !== 1) throw new OpportunityCollectionMigrationError('The verified source record could not be removed; rerun the migration to reconcile it.');
    // The source is retained until each target copy is verified, allowing safe restart after a failure.
  }

  const remaining = await source.countDocuments();
  if (remaining === 0) await source.drop();
  return { migrated, alreadyPresent };
}
