import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { createGeminiOutreachDraft, createOutreachDraft, validateOutreachDraft } from '../src/application/outreach-draft.ts';

const profile = parseApplicantProfile(JSON.parse(await readFile(new URL('../private.profile.example.json', import.meta.url), 'utf8')));
profile.applicant.fullName = 'Synthetic Applicant';
profile.applicant.degree.title = 'BSc Computer Science';
profile.applicant.degree.institution = 'Example College';
profile.applicant.target.intake = 'Fall 2027';
profile.applicant.target.researchInterests = ['distributed systems'];
profile.applicant.documents.projectUrls = ['https://projects.example.test/demo'];

const profileUrl = 'https://university.example.edu/people/professor';
const contactUrl = 'https://university.example.edu/people/contact';
const observation = 'Our group studies resilient distributed systems for public infrastructure.';
const candidate: ProfessorCandidate = {
  id: 'candidate-1', name: 'Professor profile | Example University', professorName: 'Synthetic Professor', institution: 'Example University', country: 'Exampleland',
  officialProfileUrl: profileUrl, officialContactUrl: contactUrl, officialEmail: 'professor@example.edu', emailSourceUrl: contactUrl,
  sourceCheckedAt: '2026-10-19T12:00:00.000Z', status: 'ready-for-review', approvedForSending: false, priority: 1,
  discoveryEvidence: [
    { kind: 'professor-profile', sourceUrl: profileUrl, excerpt: `Research areas. ${observation} Further details.`, retrievedAt: '2026-10-19T12:00:00.000Z', verification: 'reviewed', region: 'Exampleland', query: 'reviewed source' },
    { kind: 'contact', sourceUrl: contactUrl, excerpt: 'Official contact details.', retrievedAt: '2026-10-19T12:00:00.000Z', verification: 'reviewed', region: 'Exampleland', query: 'reviewed source' },
  ],
};

test('creates a source-cited draft from reviewed evidence without approving outreach', () => {
  const draft = createOutreachDraft({ candidate, profile, researchSourceUrl: profileUrl, researchExcerpt: observation, now: '2026-10-20T12:00:00Z' });
  assert.equal(draft.recipientEmail, 'professor@example.edu');
  assert.match(draft.body, /distributed systems/);
  assert.match(draft.body, /Source: https:\/\/university\.example\.edu\/people\/professor/);
  assert.match(draft.body, /Synthetic Applicant/);
  assert.deepEqual(validateOutreachDraft(draft, []), []);
  assert.equal(candidate.approvedForSending, false);
  assert.equal(candidate.status, 'ready-for-review');
});

test('rejects unreviewed or invented personalization and contact details', () => {
  assert.throws(() => createOutreachDraft({ candidate: { ...candidate, status: 'needs-evidence' }, profile, researchSourceUrl: profileUrl, researchExcerpt: observation }), /reviewed professor profile/);
  assert.throws(() => createOutreachDraft({ candidate, profile, researchSourceUrl: profileUrl, researchExcerpt: 'A made-up research claim that is not on the source.' }), /exact passage/);
  const { officialEmail: _unusedEmail, ...candidateWithoutEmail } = candidate;
  assert.throws(() => createOutreachDraft({ candidate: candidateWithoutEmail, profile, researchSourceUrl: profileUrl, researchExcerpt: observation }), /official contact source/);
});

test('draft validation rejects previously contacted recipients and missing personalization', () => {
  const draft = createOutreachDraft({ candidate, profile, researchSourceUrl: profileUrl, researchExcerpt: observation });
  const issues = validateOutreachDraft(draft, [{ candidateId: 'other', recipientEmail: ' PROFESSOR@example.edu ', scheduledFor: '2026-10-20T12:00:00Z', state: 'queued' }]);
  assert.ok(issues.some((issue) => issue.includes('already been scheduled')));

  const generic = { ...draft, body: 'Dear Professor, I am interested in joining your research group.' };
  assert.ok(validateOutreachDraft(generic, []).includes('draft is too short to review'));
  assert.ok(validateOutreachDraft(generic, []).includes('draft must retain its cited personalization excerpt'));
});

test('Gemini wording remains source-validated and cannot draft for a prior recipient', async () => {
  const provider = new (await import('../src/infrastructure/gemini-draft-provider.ts')).GeminiDraftProvider({
    apiKey: 'synthetic-key', fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      subject: 'Prospective MSc research inquiry',
      body: `Dear Synthetic Professor, I read this passage: "${observation}" It relates to my interest in distributed systems. Please let me know whether a conversation could be useful. Source: ${profileUrl}`,
    }) }] } }] }),
  });
  const draft = await createGeminiOutreachDraft({ candidate, profile, researchSourceUrl: profileUrl, researchExcerpt: observation, attempts: [], provider });
  assert.equal(draft.subject, 'Prospective MSc research inquiry');
  assert.deepEqual(validateOutreachDraft(draft, []), []);
  await assert.rejects(createGeminiOutreachDraft({
    candidate, profile, researchSourceUrl: profileUrl, researchExcerpt: observation, attempts: [
      { candidateId: 'previous', recipientEmail: 'professor@example.edu', scheduledFor: '2026-10-20T12:00:00Z', state: 'sent' },
    ], provider,
  }), /already been scheduled/);
});
