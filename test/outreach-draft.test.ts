import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { createGeminiOutreachDraft, createLocalAcceptedOutreachDraftPreview, createOutreachDraft, validateOutreachDraft } from '../src/application/outreach-draft.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';

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

test('regular drafts personalize with an interest matched by the reviewed research excerpt', () => {
  const draftProfile = structuredClone(profile);
  draftProfile.applicant.target.researchInterests = ['Cybersecurity, privacy, and network security', 'distributed systems'];
  const draft = createOutreachDraft({ candidate, profile: draftProfile, researchSourceUrl: profileUrl, researchExcerpt: observation });
  assert.match(draft.subject, /distributed systems/);
  assert.doesNotMatch(draft.subject, /Cybersecurity/);
});

test('accepted candidate-03 local evidence creates an unsent preview without inventing a recipient', () => {
  const officialUrl = `https://${OFFICIAL_HOSTS_BY_REGION.Canada[0]}/people/elliot-creager`;
  const draftProfile = structuredClone(profile);
  draftProfile.applicant.target.researchInterests = ['Cybersecurity, privacy, and network security', 'AI and machine learning'];
  const excerpt = 'Dr. Creager’s research spans a range of topics within machine learning, with a focus on algorithmic fairness, representation learning, and robustness.';
  const preview = createLocalAcceptedOutreachDraftPreview({
    candidateId: 'candidate-03', professorName: 'Elliot Creager', institution: 'University of Waterloo', country: 'Canada',
    officialProfileUrl: officialUrl, researchSourceUrl: officialUrl, researchExcerpt: excerpt, profile: draftProfile,
    ownerDecision: { decision: 'accepted', scope: 'local_preview_only', mongoSaved: false }, identityEstablished: true, researchMatchEstablished: true,
    now: '2026-11-09T12:00:00Z',
  });

  assert.equal(preview.recipientEmail, null);
  assert.equal(preview.recipientStatus, 'unavailable');
  assert.match(preview.subject, /AI and machine learning/);
  assert.doesNotMatch(preview.subject, /Cybersecurity/);
  assert.ok(preview.body.includes(excerpt));
  assert.ok(preview.body.includes(`Source: ${officialUrl}`));
  assert.equal(preview.ownerDecision, 'accepted_local_only');
  assert.equal(preview.approved, false);
  assert.equal(preview.queued, false);
  assert.equal(preview.sent, false);
  assert.equal(preview.mongoWrites, 0);
  assert.ok(preview.claimSupport.some((item) => item.claim === 'Quoted research statement' && item.evidence.includes(officialUrl)));
  assert.ok(preview.claimSupport.some((item) => item.claim === 'Research-interest connection'));
});

test('local draft preview rejects unaccepted decisions, non-official sources, and unmatched evidence', () => {
  const officialUrl = `https://${OFFICIAL_HOSTS_BY_REGION.Canada[0]}/people/elliot-creager`;
  const draftProfile = structuredClone(profile);
  draftProfile.applicant.target.researchInterests = ['Cybersecurity, privacy, and network security', 'AI and machine learning'];
  const input = {
    candidateId: 'candidate-03', professorName: 'Elliot Creager', institution: 'University of Waterloo', country: 'Canada',
    officialProfileUrl: officialUrl, researchSourceUrl: officialUrl,
    researchExcerpt: 'Dr. Creager’s research spans a range of topics within machine learning, with a focus on algorithmic fairness, representation learning, and robustness.',
    profile: draftProfile, ownerDecision: { decision: 'accepted' as const, scope: 'local_preview_only' as const, mongoSaved: false as const },
    identityEstablished: true as const, researchMatchEstablished: true as const,
  };
  assert.throws(() => createLocalAcceptedOutreachDraftPreview({ ...input, ownerDecision: { decision: 'rejected', scope: 'local_preview_only', mongoSaved: false } } as unknown as Parameters<typeof createLocalAcceptedOutreachDraftPreview>[0]), /Accepted local identity/);
  assert.throws(() => createLocalAcceptedOutreachDraftPreview({ ...input, researchSourceUrl: 'https://outside.example/profile' }), /Official profile/);
  assert.throws(() => createLocalAcceptedOutreachDraftPreview({ ...input, researchMatchEstablished: false } as unknown as Parameters<typeof createLocalAcceptedOutreachDraftPreview>[0]), /Accepted local identity/);
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
