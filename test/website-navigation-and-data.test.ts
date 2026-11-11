import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import type { GradReachRepositories } from '../src/infrastructure/mongo-storage.ts';
import { createEmptyApplicantProfile } from '../src/domain/applicant-profile.ts';
import { loadOwnerWorkspace } from '../src/web/owner-workspace-loader.ts';
import { isWorkspaceNavigationActive, workspaceNavigation } from '../src/web/workspace-navigation.ts';

test('workspace navigation covers each focused feature route and marks only its current page', () => {
  const expected = ['/workspace', '/leads', '/confirmed-professors', '/programs', '/profile', '/drafts', '/outreach', '/discovery'];
  assert.deepEqual(workspaceNavigation.map((item) => item.href), expected);
  for (const href of expected) assert.equal(isWorkspaceNavigationActive(href, href), true);
  assert.equal(isWorkspaceNavigationActive('/leads/123', '/leads'), true);
  assert.equal(isWorkspaceNavigationActive('/leads', '/workspace'), false);
});

test('workspace navigation provides an accessible responsive mobile toggle and active link state', async () => {
  const source = await readFile(new URL('../src/web/workspace-navigation-client.tsx', import.meta.url), 'utf8');
  assert.match(source, /lg:hidden/);
  assert.match(source, /lg:flex/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /aria-controls="workspace-mobile-navigation"/);
  assert.match(source, /aria-current=\{active \? 'page' : undefined\}/);
  assert.match(source, /fixed inset-0 z-40/);
  assert.match(source, /fixed bottom-0 left-0 top-14/);
  assert.match(source, /fixed inset-y-0 left-0.*w-\[232px\]/s);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /Close navigation menu/);
  assert.match(source, /onClick=\{closeMenu\}/);
  assert.match(source, /hidden=\{!open\}/);
  const shell = await readFile(new URL('../app/(owner)/layout.tsx', import.meta.url), 'utf8');
  assert.match(shell, /<WorkspaceNavigation\s*\/>/);
  assert.doesNotMatch(shell, /Research desk/);
});

test('workspace loader uses saved repository values for profile, leads, programs and outreach counts', async () => {
  const profile = createEmptyApplicantProfile();
  profile.applicant.target.countries = ['Saved Country'];
  const candidate: ProfessorCandidate = {
    id: 'saved-record', name: 'Official page title', institution: 'Saved University', country: 'Saved Country',
    status: 'needs-evidence', approvedForSending: false, priority: 0,
  };
  let requestedProfileId = '';
  const repositories = {
    profiles: { async get(id: string) { requestedProfileId = id; return profile; } },
    candidates: { async list() { return [candidate]; } },
    evidenceTriage: { async list() { return []; } },
    discoveryChecks: { async list() { return []; } },
    programs: { async list() { return []; } },
    attempts: { async listAll() { return []; } },
    schedulerControl: { async get() { return { paused: true, timeZone: 'Africa/Lagos', dailyLimit: 5 }; } },
    assessments: { async latest() { return undefined; } },
  } as unknown as GradReachRepositories;

  const workspace = await loadOwnerWorkspace(repositories, '2026-10-31T12:00:00Z');
  assert.equal(requestedProfileId, 'primary');
  assert.equal(workspace.profile.applicant.target.countries[0], 'Saved Country');
  assert.equal(workspace.candidates[0]?.id, 'saved-record');
  assert.equal(workspace.dashboard.candidates, 1);
  assert.equal(workspace.dashboard.programs, 0);
  assert.equal(workspace.control.paused, true);
});

test('private route source files load through the authenticated owner workspace and provide empty states', async () => {
  const routes = [
    ['workspace/page.tsx', 'getOwnerWorkspace'], ['leads/page.tsx', 'getOwnerWorkspace'], ['confirmed-professors/page.tsx', 'loadConfirmedProfessorPreviewData'],
    ['programs/page.tsx', 'getOwnerWorkspace'], ['drafts/page.tsx', 'getOwnerWorkspace'],
    ['outreach/page.tsx', 'getOwnerWorkspace'], ['profile/page.tsx', 'withOwnerData'], ['discovery/page.tsx', 'getAutomaticDiscoverySettings'],
  ] as const;
  for (const [route, loader] of routes) {
    const source = await readFile(new URL(`../app/(owner)/${route}`, import.meta.url), 'utf8');
    assert.ok(source.includes(loader), `${route} should use the owner data gateway`);
  }
  const leads = await readFile(new URL('../src/web/lead-browser.tsx', import.meta.url), 'utf8');
  const drafts = await readFile(new URL('../app/(owner)/drafts/page.tsx', import.meta.url), 'utf8');
  assert.match(leads, /No saved leads/);
  assert.match(drafts, /No drafts are ready for review/);
  assert.match(leads, /Lead type/);
  assert.match(leads, /Lead status/);
  assert.match(leads, /Prepared research evidence/);
  assert.match(leads, /Matching saved interests/);
  assert.match(leads, /Uncertain because/);
  assert.match(leads, /Open official profile source/);
  const programs = await readFile(new URL('../app/(owner)/programs/page.tsx', import.meta.url), 'utf8');
  assert.match(programs, /Filter records|Find a program/);
  const profile = await readFile(new URL('../app/(owner)/profile/page.tsx', import.meta.url), 'utf8');
  const preferences = await readFile(new URL('../src/web/research-preferences-editor.tsx', import.meta.url), 'utf8');
  assert.match(preferences, /name=\{name\}/);
  assert.match(preferences, /name === 'targetCountry'/);
  assert.match(profile, /Saved preferences control manual and scheduled discovery/);
  assert.match(profile, /className=\{`\$\{ui\.stack\} w-full`\}/);
  assert.match(profile, /grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3/);
  assert.doesNotMatch(profile, /max-w-5xl/);
  const loading = await readFile(new URL('../app/(owner)/loading.tsx', import.meta.url), 'utf8');
  const error = await readFile(new URL('../app/(owner)/error.tsx', import.meta.url), 'utf8');
  assert.match(loading, /aria-busy="true"/);
  assert.match(error, /role="alert"/);
  const ownerLayout = await readFile(new URL('../app/(owner)/layout.tsx', import.meta.url), 'utf8');
  const confirmedPage = await readFile(new URL('../app/(owner)/confirmed-professors/page.tsx', import.meta.url), 'utf8');
  const confirmedLoader = await readFile(new URL('../src/web/confirmed-professors-data.ts', import.meta.url), 'utf8');
  assert.match(ownerLayout, /await requireOwner\(\)/);
  assert.match(confirmedPage, /loadConfirmedProfessorPreviewData/);
  assert.match(confirmedLoader, /import 'server-only'/);
  assert.doesNotMatch(confirmedLoader, /connectMongoStorage|\.repositories\./);
  assert.match(confirmedPage, /Local previews are not available yet/);
  assert.match(confirmedPage, /No verified professors in the available reports/);
  assert.match(confirmedPage, /Confirmed professors/);
});
