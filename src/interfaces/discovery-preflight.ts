import '../infrastructure/local-env.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

interface PreflightStorage {
  repositories: {
    profiles: { get(profileId: string): Promise<ApplicantProfile | undefined> };
    candidates: { list(): Promise<ProfessorCandidate[]> };
  };
  close(): Promise<void>;
}

/** Reads only saved profile preferences and lead IDs, reporting presence without printing either. */
export async function runReadOnlyDiscoveryPreflight(connect: () => Promise<PreflightStorage>): Promise<{
  ok: boolean;
  profilePreferencesRead: boolean;
  profileCountriesConfigured: boolean;
  leadIdsRead: boolean;
  leadCount?: number;
  failureKind?: string;
}> {
  let storage: PreflightStorage | undefined;
  try {
    storage = await connect();
    const profile = await storage.repositories.profiles.get('primary');
    const leads = await storage.repositories.candidates.list();
    const profilePreferencesRead = Boolean(profile?.applicant.target.fields.length && profile.applicant.target.researchInterests.length);
    const profileCountriesConfigured = Boolean(profile?.applicant.target.countries.length);
    const leadIdsRead = leads.every((lead) => typeof lead.id === 'string' && lead.id.length > 0);
    return {
      ok: profilePreferencesRead && profileCountriesConfigured && leadIdsRead,
      profilePreferencesRead,
      profileCountriesConfigured,
      leadIdsRead,
      leadCount: leads.length,
    };
  } catch (error) {
    return {
      ok: false,
      profilePreferencesRead: false,
      profileCountriesConfigured: false,
      leadIdsRead: false,
      failureKind: safeFailureRecord(error).kind,
    };
  } finally {
    try { await storage?.close(); } catch { /* A read-only preflight does not expose shutdown errors. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runReadOnlyDiscoveryPreflight(() => connectMongoStorage());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
