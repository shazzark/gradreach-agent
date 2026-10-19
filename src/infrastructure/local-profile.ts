import { readFile } from 'node:fs/promises';
import { parseApplicantProfile, type ApplicantProfile } from '../domain/applicant-profile.ts';

/** Reads the user-selected local profile path; the default file is ignored by Git. */
export async function loadApplicantProfile(
  path = process.env.GRADREACH_PROFILE_PATH ?? 'private.profile.json',
): Promise<ApplicantProfile> {
  const contents = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Applicant profile at ${path} is not valid JSON`);
  }
  return parseApplicantProfile(parsed);
}
