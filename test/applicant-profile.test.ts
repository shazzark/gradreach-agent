import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEmptyApplicantProfile, isApplicantProfileIncomplete, parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import { loadApplicantProfile } from '../src/infrastructure/local-profile.ts';

const examplePath = fileURLToPath(new URL('../private.profile.example.json', import.meta.url));

async function exampleProfile(): Promise<unknown> {
  return JSON.parse(await readFile(examplePath, 'utf8')) as unknown;
}

test('parses the blank example profile without requiring private applicant details', async () => {
  const profile = parseApplicantProfile(await exampleProfile());
  assert.equal(profile.applicant.fullName, '');
  assert.equal(profile.applicant.target.degreeLevel, 'masters');
  assert.equal(profile.applicant.target.timezone, 'Africa/Lagos');
  assert.deepEqual(profile.applicant.target.fundingTypes, ['scholarship', 'low-tuition']);
});

test('normalizes a missing or incomplete saved profile without requiring optional personal details', () => {
  const profile = parseApplicantProfile({ applicant: { degree: { title: 'BSc Computer Science' } } });
  assert.equal(profile.applicant.degree.title, 'BSc Computer Science');
  assert.equal(profile.applicant.phone, '');
  assert.equal(profile.applicant.email, '');
  assert.equal(profile.applicant.degree.gpaScale, null);
  assert.equal(profile.applicant.englishEvidence.testName, '');
  assert.equal(profile.applicant.documents.transcriptPath, '');
  assert.deepEqual(profile.applicant.documents.projectUrls, []);
  assert.equal(isApplicantProfileIncomplete(profile), true);
  assert.equal(isApplicantProfileIncomplete(createEmptyApplicantProfile()), true);
});

test('loads and validates a profile from a local JSON path', async () => {
  const profile = await loadApplicantProfile(examplePath);
  assert.equal(profile.applicant.target.degreeLevel, 'masters');
});

test('rejects malformed GPA values', async () => {
  const profile = await exampleProfile() as { applicant: { degree: { gpa: unknown } } };
  profile.applicant.degree.gpa = 'unknown';
  assert.throws(() => parseApplicantProfile(profile), /gpa must be a finite number or null/);
});

test('rejects invalid timezones before they reach the daily queue', async () => {
  const profile = await exampleProfile() as { applicant: { target: { timezone: string } } };
  profile.applicant.target.timezone = 'Mars/Olympus';
  assert.throws(() => parseApplicantProfile(profile), /timezone must be a valid IANA timezone/);
});

test('rejects non-master target level for this MSc project', async () => {
  const profile = await exampleProfile() as { applicant: { target: { degreeLevel: string } } };
  profile.applicant.target.degreeLevel = 'doctoral';
  assert.throws(() => parseApplicantProfile(profile), /degreeLevel must be masters/);
});

test('requires configured countries to be non-empty, trimmed, and unique', async () => {
  const profile = await exampleProfile() as { applicant: { target: { countries: string[] } } };
  profile.applicant.target.countries = ['Canada', ' canada '];
  assert.throws(() => parseApplicantProfile(profile), /countries entries must be trimmed and unique/);

  profile.applicant.target.countries = ['Canada', ''];
  assert.throws(() => parseApplicantProfile(profile), /countries entries must not be empty/);
});
