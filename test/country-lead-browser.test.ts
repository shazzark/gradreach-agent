import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { browseLeadsByDiscoveryRegion } from '../src/application/country-lead-browser.ts';

const namedProfessor: ProfessorCandidate = {
  id: 'named-professor', name: 'Professor profile page', professorName: 'Professor Example',
  institution: 'Example University', country: 'Canada', searchRegion: 'South Korea',
  leadType: 'professor_profile', officialProfileUrl: 'https://cs.example.edu/profile',
  discoveryEvidence: [{ kind: 'professor-profile', sourceUrl: 'https://cs.example.edu/profile', excerpt: 'Professor Example leads work on resilient distributed systems and verification of complex software services.', quote: 'Professor Example leads work on resilient distributed systems and verification of complex software services.', retrievedAt: '2026-10-31T00:00:00Z', verification: 'unverified', region: 'South Korea', query: 'fixture' }],
  status: 'needs-evidence', approvedForSending: false, priority: 0,
};

const generalLead: ProfessorCandidate = {
  id: 'general-lead', name: 'Computer Science Department', professorName: '',
  institution: 'Another University', country: '', leadType: 'school',
  discoveryEvidence: [{ kind: 'official-page', sourceUrl: 'https://another.example.edu/cs', excerpt: 'Department page.', retrievedAt: '2026-10-31T00:00:00Z', verification: 'unverified', region: 'South Korea', query: 'fixture' }],
  status: 'needs-evidence', approvedForSending: false, priority: 0,
};

test('country browser matches discovery region and keeps professor affiliation separate', () => {
  const before = structuredClone([namedProfessor, generalLead]);
  const result = browseLeadsByDiscoveryRegion([namedProfessor, generalLead], ' south korea ');

  assert.equal(result.region, 'south korea');
  assert.deepEqual(result.professors.map((candidate) => candidate.id), ['named-professor']);
  assert.deepEqual(result.general.map((candidate) => candidate.id), ['general-lead']);
  assert.equal(result.professors[0]?.country, 'Canada');
  assert.deepEqual([namedProfessor, generalLead], before);
});

test('country browser does not mistake actual country for a discovery region', () => {
  const { searchRegion: _searchRegion, discoveryEvidence: _discoveryEvidence, ...candidate } = namedProfessor;
  const result = browseLeadsByDiscoveryRegion([candidate], 'Canada');

  assert.deepEqual(result.professors, []);
  assert.deepEqual(result.general, []);
});

test('country browser uses saved evidence region for older leads without searchRegion', () => {
  const { searchRegion: _searchRegion, ...legacyLead } = generalLead;
  const result = browseLeadsByDiscoveryRegion([legacyLead], 'South Korea');

  assert.deepEqual(result.general.map((candidate) => candidate.id), ['general-lead']);
});

test('country browser keeps an unsupported professor label in general leads', () => {
  const unsupportedProfile: ProfessorCandidate = {
    ...generalLead, id: 'unsupported-profile', professorName: 'Guessed Person', leadType: 'professor_profile',
    officialProfileUrl: 'https://another.example.edu/person',
  };
  const result = browseLeadsByDiscoveryRegion([unsupportedProfile], 'South Korea');

  assert.deepEqual(result.professors, []);
  assert.deepEqual(result.general.map((candidate) => candidate.id), ['unsupported-profile']);
});
