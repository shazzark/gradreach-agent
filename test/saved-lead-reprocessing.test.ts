import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { reprocessSavedProfessorLeads } from '../src/application/reprocess-saved-professor-leads.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../src/config/official-host-allowlist.ts';
import { SanitizedIntegrationError } from '../src/infrastructure/sanitized-failure.ts';
import type { SavedLeadReprocessResult } from '../src/domain/saved-lead-reprocessing.ts';

const profile = parseApplicantProfile({
  applicant: {
    fullName: '', email: '', phone: '', nationality: '', currentLocation: '',
    degree: { title: '', institution: '', country: '', graduationYear: null, classification: '', gpa: null, gpaScale: null, gradingScaleDocument: '' },
    target: { degreeLevel: 'masters', intake: '2027', fields: ['Computer Science'], researchInterests: ['distributed systems'], countries: ['Japan'], fundingTypes: ['scholarship'], timezone: 'Africa/Lagos' },
    englishEvidence: { testStatus: '', testName: '', score: '', testDate: '', mediumOfInstructionLetter: '' },
    documents: { academicCvPath: '', transcriptPath: '', portfolioUrl: '', githubUrl: '', projectUrls: [] },
  },
});

function lead(id: string, overrides: Partial<ProfessorCandidate> = {}): ProfessorCandidate {
  const host = OFFICIAL_HOSTS_BY_REGION.Japan[0]!;
  return {
    id, name: `Faculty directory result ${id}`, institution: '', country: '', searchRegion: 'Japan', leadType: 'discovery',
    status: 'needs-evidence', approvedForSending: false, priority: 0,
    discoveryEvidence: [{ kind: 'search-result', sourceUrl: `https://${host}/people/${id}`, excerpt: 'Official search result.', retrievedAt: '2026-11-01T00:00:00.000Z', verification: 'unverified', region: 'Japan', query: 'private query text' }],
    ...overrides,
  };
}

test('search-free reprocessing enriches only interest-matching leads and preserves all protected state', async () => {
  const host = OFFICIAL_HOSTS_BY_REGION.Japan[0]!;
  const accepted = lead('ada', { officialEmail: 'ada@example.edu', personalizedDraft: 'Existing draft', approvedDraftHash: 'existing-hash', priority: 7 });
  const mismatch = lead('ben');
  const reviewed = lead('reviewed', { discoveryReview: { decision: 'rejected', reviewedAt: '2026-11-03T00:00:00.000Z' } });
  const approved = lead('approved', { status: 'approved', approvedForSending: true, approvedAt: '2026-11-04T00:00:00.000Z' });
  const records = [accepted, mismatch, reviewed, approved];
  const beforeProtected = structuredClone(records.map(({ id, status, approvedForSending, approvedAt, discoveryReview, personalizedDraft, approvedDraftHash, priority }) => ({ id, status, approvedForSending, approvedAt, discoveryReview, personalizedDraft, approvedDraftHash, priority })));
  const fetched: string[] = [];
  const writes: Array<{ candidateId: string; evidenceCount: number }> = [];
  const outcomes: SavedLeadReprocessResult[] = [];
  const pages = new Map<string, string>([
    [`https://${host}/people/ada`, '<h1>Dr Ada Lovelace</h1><p>Associate Professor.</p><a href="/research/ada">Research interests</a>'],
    [`https://${host}/research/ada`, '<h1>Research</h1><p>Her research focuses on distributed systems and fault-tolerant computing across large-scale networks.</p>'],
    [`https://${host}/people/ben`, '<h1>Dr Ben Example</h1><p>Professor of Computing.</p><a href="/research/ben">Research group</a>'],
    [`https://${host}/research/ben`, '<h1>Research</h1><p>His research investigates marine biology and coastal ecosystems across the North Atlantic.</p>'],
  ]);
  const report = await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: {
        async list() { return records; },
        async appendValidatedResearchEvidence(input) {
          const current = records.find(({ id }) => id === input.candidateId)!;
          assert.equal(current.officialProfileUrl, input.expectedOfficialProfileUrl);
          assert.equal(current.professorName, input.expectedProfessorName);
          current.name = input.leadName;
          current.professorName = input.professorName;
          current.leadType = 'professor_profile';
          current.officialProfileUrl = input.officialProfileUrl;
          current.discoveryEvidence = [...(current.discoveryEvidence ?? []), ...input.evidence];
          writes.push({ candidateId: input.candidateId, evidenceCount: input.evidence.length });
          return true;
        },
      },
    },
    officialHostsByRegion: { Japan: [host] },
    async fetchPage(url) { fetched.push(url); return { url, html: pages.get(url) ?? '' }; },
    runId: 'synthetic-run-id',
    async onLeadResult(result) { outcomes.push(result); },
    now: new Date('2026-11-09T10:00:00.000Z'),
  });

  assert.deepEqual(report.counts, { inspected: 4, enriched: 1, unchanged: 3, failed: 0, pageFetches: 4 }, JSON.stringify(report));
  assert.deepEqual(report.reasonCounts, { evidence_added: 1, interest_mismatch: 1, protected_state: 2 });
  const enrichedOutcome = outcomes.find(({ outcome }) => outcome === 'enriched')!;
  assert.equal(enrichedOutcome.reasonCode, 'evidence_added');
  assert.equal(enrichedOutcome.diagnostics.stageOutcome, 'enriched');
  assert.deepEqual(enrichedOutcome.diagnostics.traversal, {
    directoryFetched: false, profileLinksConsidered: 0, profileLinksSelected: 0, profileLinksFetched: 0,
    identityEstablished: true, researchLinksConsidered: 1, researchLinksEligible: 1,
    researchLinksSelected: 1, researchLinksFetched: 1, relevantResearchEstablished: true,
  });
  assert.deepEqual(writes.map(({ candidateId }) => candidateId), ['ada']);
  assert.ok(accepted.discoveryEvidence?.some((item) => item.kind === 'research' && item.quote?.includes('distributed systems')));
  assert.deepEqual(records.map(({ id, status, approvedForSending, approvedAt, discoveryReview, personalizedDraft, approvedDraftHash, priority }) => ({ id, status, approvedForSending, approvedAt, discoveryReview, personalizedDraft, approvedDraftHash, priority })), beforeProtected);
  assert.ok(fetched.every((url) => new URL(url).hostname === host));
  assert.equal(accepted.id, 'ada');
  assert.equal(JSON.stringify(report).includes('private query text'), false);
  assert.equal(JSON.stringify(report).includes('ada@example.edu'), false);
  assert.equal(JSON.stringify(outcomes).includes('Ada Lovelace'), false);
  assert.equal(JSON.stringify(outcomes).includes('https://'), false);
  assert.equal(JSON.stringify(outcomes).includes('distributed systems'), false);
});

test('reprocessing leaves duplicate professor profiles unchanged and reports a safe reason', async () => {
  const host = OFFICIAL_HOSTS_BY_REGION.Japan[0]!;
  const duplicateA = lead('one', { officialProfileUrl: `https://${host}/people/shared` });
  const duplicateB = lead('two', { officialProfileUrl: `https://${host}/people/shared` });
  let fetches = 0;
  let writes = 0;
  const report = await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: { async list() { return [duplicateA, duplicateB]; }, async appendValidatedResearchEvidence() { writes += 1; return true; } },
    },
    officialHostsByRegion: { Japan: [host] },
    async fetchPage(url) { fetches += 1; return { url, html: '' }; },
    runId: 'duplicate-run',
  });
  assert.deepEqual(report.counts, { inspected: 2, enriched: 0, unchanged: 2, failed: 0, pageFetches: 0 });
  assert.deepEqual(report.reasonCounts, { duplicate_profile: 2 });
  assert.equal(fetches, 0);
  assert.equal(writes, 0);
});

test('identity failures persist bounded profile traversal counts and stage outcomes', async () => {
  const host = OFFICIAL_HOSTS_BY_REGION.Japan[0]!;
  const candidate = lead('identity-stage');
  const source = candidate.discoveryEvidence![0]!.sourceUrl;
  const profileUrl = `https://${host}/people/ada`;
  const results: SavedLeadReprocessResult[] = [];
  const report = await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: { async list() { return [candidate]; }, async appendValidatedResearchEvidence() { assert.fail('identity failure must not write'); } },
    },
    officialHostsByRegion: { Japan: [host] }, runId: 'identity-run',
    async fetchPage(url) {
      if (url === source) return { url, html: '<h1>Faculty directory</h1><a href="/people/ada">Dr Ada Lovelace</a>' };
      return { url, html: '<h1>Faculty profile</h1><p>University research centre page.</p>' };
    },
    async onLeadResult(result) { results.push(result); },
  });
  assert.equal(report.reasonCounts.identity_not_established, 1);
  assert.deepEqual(results[0]?.diagnostics, {
    stageOutcome: 'identity_check',
    traversal: {
      directoryFetched: true, profileLinksConsidered: 1, profileLinksSelected: 1, profileLinksFetched: 1,
      identityEstablished: false, researchLinksConsidered: 0, researchLinksEligible: 0,
      researchLinksSelected: 0, researchLinksFetched: 0, relevantResearchEstablished: false,
    },
  });
  assert.equal(JSON.stringify(results).includes('Ada Lovelace'), false);
  assert.equal(JSON.stringify(results).includes(profileUrl), false);
});

test('confirmed identity without relevant research is classified at the research stage', async () => {
  const host = OFFICIAL_HOSTS_BY_REGION.Japan[0]!;
  const candidate = lead('identity-no-research');
  const results: SavedLeadReprocessResult[] = [];
  await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: { async list() { return [candidate]; }, async appendValidatedResearchEvidence() { assert.fail('missing research must not write'); } },
    },
    officialHostsByRegion: { Japan: [host] }, runId: 'research-stage-run',
    async fetchPage(url) { return { url, html: '<h1>Dr Ada Lovelace</h1><p>Associate Professor in Computing.</p>' }; },
    async onLeadResult(result) { results.push(result); },
  });
  assert.equal(results[0]?.reasonCode, 'research_evidence_missing');
  assert.equal(results[0]?.diagnostics.stageOutcome, 'research_check');
  assert.equal(results[0]?.diagnostics.traversal.identityEstablished, true);
  assert.equal(results[0]?.diagnostics.traversal.relevantResearchEstablished, false);
});

test('HTTP page failures retain only a validated numeric status and fixed stage code', async () => {
  const host = OFFICIAL_HOSTS_BY_REGION.Japan[0]!;
  const candidate = lead('http-status');
  const results: SavedLeadReprocessResult[] = [];
  await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: { async list() { return [candidate]; }, async appendValidatedResearchEvidence() { assert.fail('fetch failure must not write'); } },
    },
    officialHostsByRegion: { Japan: [host] }, runId: 'http-run',
    async fetchPage(url) { throw new SanitizedIntegrationError('http_status', { statusCode: 503, resourceUrl: url, responseReceived: true }); },
    async onLeadResult(result) { results.push(result); },
  });
  assert.equal(results[0]?.reasonCode, 'http_status');
  assert.equal(results[0]?.diagnostics.stageOutcome, 'official_page_fetch');
  assert.equal(results[0]?.diagnostics.failedStage, 'official_page_fetch');
  assert.equal(results[0]?.diagnostics.httpStatus, 503);
  assert.equal(JSON.stringify(results).includes('https://'), false);
});

test('invalid and unsupported content persist controlled error codes only', async () => {
  const host = OFFICIAL_HOSTS_BY_REGION.Japan[0]!;
  const empty = lead('empty-content');
  const unsupported = lead('unsupported-content');
  const results: SavedLeadReprocessResult[] = [];
  await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: { async list() { return [empty, unsupported]; }, async appendValidatedResearchEvidence() { assert.fail('content failures must not write'); } },
    },
    officialHostsByRegion: { Japan: [host] }, runId: 'content-run',
    async fetchPage(url) {
      if (url.endsWith('/empty-content')) throw new SanitizedIntegrationError('invalid_content', { statusCode: 200, bodyEmpty: true, resourceUrl: url, responseReceived: true });
      throw new SanitizedIntegrationError('invalid_content', { statusCode: 200, contentTypeIsHtml: false, bodyEmpty: false, resourceUrl: url, responseReceived: true });
    },
    async onLeadResult(result) { results.push(result); },
  });
  assert.deepEqual(results.map(({ diagnostics }) => [diagnostics.httpStatus, diagnostics.contentErrorCode]), [
    [200, 'empty_content'], [200, 'unsupported_document'],
  ]);
  assert.equal(JSON.stringify(results).includes('https://'), false);
  assert.equal(JSON.stringify(results).includes('invalid_content response body'), false);
});

test('zero qualifying leads produce a sanitized outcome without network requests', async () => {
  const rejected = lead('not-official', { discoveryEvidence: [] });
  const report = await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: { async list() { return [rejected]; }, async appendValidatedResearchEvidence() { assert.fail('must not write'); } },
    },
    async fetchPage() { assert.fail('must not fetch'); },
    runId: 'zero-match-run',
  });
  assert.deepEqual(report.counts, { inspected: 1, enriched: 0, unchanged: 1, failed: 0, pageFetches: 0 });
  assert.deepEqual(report.reasonCounts, { missing_source: 1 });
  assert.equal(JSON.stringify(report).includes('not-official'), false);
});

test('stable lead identifiers are processed once per run', async () => {
  const repeated = lead('same-stable-id');
  const report = await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: { async list() { return [repeated, structuredClone(repeated)]; }, async appendValidatedResearchEvidence() { assert.fail('must not write'); } },
    },
    async fetchPage() { assert.fail('source check must stop before fetch'); },
    runId: 'dedupe-run',
  });
  assert.equal(report.counts.inspected, 1);
  assert.equal(report.duplicateIdentifiersSkipped, 1);
  assert.equal(JSON.stringify(report).includes('same-stable-id'), false);
});

test('repeated runs keep the stable lead ID and do not append the same evidence twice', async () => {
  const host = OFFICIAL_HOSTS_BY_REGION.Japan[0]!;
  const saved = lead('repeatable');
  const source = saved.discoveryEvidence![0]!.sourceUrl;
  const profileUrl = `https://${host}/faculty/repeatable`;
  const researchUrl = `https://${host}/research/repeatable`;
  const pages = new Map([
    [source, '<h1>Dr Ada Lovelace</h1><p>Associate Professor.</p><a href="/research/repeatable">Research group</a>'],
    [profileUrl, '<h1>Dr Ada Lovelace</h1><p>Associate Professor.</p><a href="/research/repeatable">Research group</a>'],
    [researchUrl, '<h1>Research group</h1><p>Her research focuses on distributed systems and reliable computer science methods for large networked applications.</p>'],
  ]);
  const repositories = {
    profiles: { async get() { return profile; } },
    candidates: {
      async list() { return [saved]; },
      async appendValidatedResearchEvidence(input: { candidateId: string; leadName: string; professorName: string; officialProfileUrl: string; evidence: NonNullable<ProfessorCandidate['discoveryEvidence']> }) {
        assert.equal(input.candidateId, 'repeatable');
        saved.name = input.leadName;
        saved.professorName = input.professorName;
        saved.officialProfileUrl = input.officialProfileUrl;
        saved.leadType = 'professor_profile';
        saved.discoveryEvidence = [...(saved.discoveryEvidence ?? []), ...input.evidence];
        return true;
      },
    },
  };
  const run = (runId: string) => reprocessSavedProfessorLeads({
    repositories, officialHostsByRegion: { Japan: [host] }, runId,
    async fetchPage(url) { return { url, html: pages.get(url) ?? '' }; },
    now: new Date('2026-11-09T10:00:00.000Z'),
  });
  const first = await run('first-run');
  const evidenceAfterFirst = saved.discoveryEvidence?.length;
  const second = await run('second-run');
  assert.equal(first.counts.enriched, 1, JSON.stringify(first));
  assert.equal(second.counts.enriched, 0);
  assert.equal(second.reasonCounts.no_new_evidence, 1);
  assert.equal(saved.id, 'repeatable');
  assert.equal(saved.discoveryEvidence?.length, evidenceAfterFirst);
});

test('per-lead failures are counted and use sanitized reason codes', async () => {
  const failedLead = lead('failure');
  const report = await reprocessSavedProfessorLeads({
    repositories: {
      profiles: { async get() { return profile; } },
      candidates: { async list() { return [failedLead]; }, async appendValidatedResearchEvidence() { assert.fail('must not write after fetch failure'); } },
    },
    officialHostsByRegion: { Japan: [new URL(failedLead.discoveryEvidence![0]!.sourceUrl).hostname] },
    async fetchPage() { throw new Error('private response text and credential'); },
    runId: 'failure-run',
  });
  assert.equal(report.counts.failed, 1);
  assert.equal(Object.values(report.reasonCounts).reduce((sum, count) => sum + (count ?? 0), 0), 1);
  assert.ok(Object.keys(report.reasonCounts).every((code) => /^[a-z_]+$/.test(code)));
  assert.equal(JSON.stringify(report).includes('private response'), false);
  assert.equal(JSON.stringify(report).includes('credential'), false);
});
