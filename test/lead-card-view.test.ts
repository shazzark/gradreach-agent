import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { evidenceCardView, leadCardView, previewSavedExcerpt } from '../src/web/lead-card-view.ts';

const savedExcerpt = `Navigation Home Faculty Research ${'Substantive saved page text. '.repeat(20)}`;
const candidate: ProfessorCandidate = {
  id: 'saved-1',
  name: 'Robotics Laboratory — Faculty and Research',
  professorName: 'Dr. Ada Example',
  institution: 'Example University',
  country: 'South Korea',
  searchRegion: 'South Korea',
  leadType: 'professor_profile',
  discoveryEvidence: [{
    kind: 'professor-profile', sourceUrl: 'https://cs.example.edu/faculty/ada?tracking=hidden', excerpt: savedExcerpt,
    retrievedAt: '2026-10-31T00:00:00Z', verification: 'unverified', region: 'South Korea', query: 'private query',
  }],
  status: 'needs-evidence', approvedForSending: false, priority: 0,
};

test('lead card view keeps saved page title separate from supported professor name', () => {
  const view = leadCardView(candidate);
  assert.equal(view.pageTitle, candidate.name);
  assert.equal(view.professorName, candidate.professorName);
  assert.equal(view.institution, 'Example University');
  assert.equal(view.country, 'South Korea');
  assert.equal(view.discoveryRegion, 'South Korea');
  assert.equal(view.status, 'needs-evidence');
  assert.equal(view.reviewDecision, 'Not reviewed');
});

test('general page title is never used to infer a professor name and missing values are explicit', () => {
  const { searchRegion: _searchRegion, ...withoutSearchRegion } = candidate;
  const view = leadCardView({ ...withoutSearchRegion, professorName: '', institution: '', country: '', discoveryEvidence: [] });
  assert.equal(view.pageTitle, candidate.name);
  assert.equal(view.professorName, 'Not established from an individual official profile');
  assert.equal(view.institution, 'Unknown');
  assert.equal(view.country, 'Unknown');
  assert.equal(view.discoveryRegion, 'Unknown');
  assert.equal(view.reviewDecision, 'Not reviewed');
});

test('excerpt preview is a compact verbatim prefix and full saved excerpt remains unchanged', () => {
  const displayed = evidenceCardView(candidate.discoveryEvidence![0]!);
  assert.ok(displayed.excerptPreview.length < savedExcerpt.length);
  assert.ok(savedExcerpt.startsWith(displayed.excerptPreview.slice(0, -1)));
  assert.equal(displayed.fullExcerpt, savedExcerpt);
  assert.equal(displayed.verification, 'unverified');
  assert.equal(displayed.retrievedDate, '2026-10-31');
});

test('evidence URL is visible and safe; unsafe URLs are marked unavailable', () => {
  const evidence = candidate.discoveryEvidence![0]!;
  assert.equal(evidenceCardView(evidence).sourceUrl, 'https://cs.example.edu/faculty/ada');
  assert.equal(evidenceCardView({ ...evidence, sourceUrl: 'javascript:alert(1)' }).sourceUrl, undefined);
});

test('short saved excerpts are displayed without alteration', () => {
  const short = 'Saved excerpt stays exact.';
  assert.equal(previewSavedExcerpt(short), short);
});
