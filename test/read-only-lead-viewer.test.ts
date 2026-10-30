import test from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateEvidenceTriage, ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { runReadOnlyLeadViewer } from '../src/interfaces/view-undecided-professor-leads.ts';

const lead: ProfessorCandidate = {
  id: 'professor-1', name: 'Dr Example', institution: 'Example University', country: '',
  leadType: 'professor_profile', officialProfileUrl: 'https://university.example.edu/professor',
  officialEmail: 'professor@university.example.edu', emailSourceUrl: 'https://university.example.edu/professor',
  discoveryEvidence: [
    { kind: 'professor-profile', sourceUrl: 'https://university.example.edu/professor', excerpt: 'An excerpt.', quote: 'Dr Example researches reliable systems.', retrievedAt: '2026-10-30T12:00:00.000Z', verification: 'unverified', region: 'Exampleland', query: 'private search text' },
    { kind: 'contact', sourceUrl: 'https://university.example.edu/professor', excerpt: 'Email evidence.', retrievedAt: '2026-10-30T12:00:00.000Z', verification: 'unverified', region: 'Exampleland', query: 'private search text' },
  ],
  status: 'needs-evidence', approvedForSending: false, priority: 0,
};

const recommendation: CandidateEvidenceTriage = {
  candidateId: lead.id, recommendation: 'likely relevant', rationale: 'The official profile describes matching systems research.',
  facts: [], triagedAt: '2026-10-30T12:00:00.000Z',
};

test('read-only viewer reads undecided leads and recommendations without startup writes or external providers', async () => {
  const calls: string[] = [];
  const output: string[] = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls.push('fetch'); throw new Error('External provider call'); }) as typeof fetch;
  try {
    const succeeded = await runReadOnlyLeadViewer({
      connect: async () => ({
        get repositories() {
          return new Proxy({
            candidates: { async list() { calls.push('candidates.list'); return [lead, { ...lead, id: 'accepted', discoveryReview: { decision: 'accepted' as const, reviewedAt: '2026-10-30T12:00:00.000Z' } }]; } },
            evidenceTriage: { async get(id: string) { calls.push(`evidenceTriage.get:${id}`); return recommendation; } },
          }, {
            get(target, property, receiver) {
              if (property === 'profiles' || property === 'schedulerControl' || property === 'attempts' || property === 'programs') {
                throw new Error(`Unexpected repository access: ${String(property)}`);
              }
              return Reflect.get(target, property, receiver);
            },
          });
        },
        async close() { calls.push('close'); },
      }),
      write(text) { output.push(text); },
    });
    assert.equal(succeeded, true);
    assert.deepEqual(calls, ['candidates.list', 'evidenceTriage.get:professor-1', 'close']);
    assert.match(output[0] ?? '', /Dr Example \| professor-1/);
    assert.match(output[0] ?? '', /Country: Unknown/);
    assert.match(output[0] ?? '', /Supporting quote: "Dr Example researches reliable systems\."/);
    assert.match(output[0] ?? '', /Official email \[unverified\]: professor@university\.example\.edu/);
    assert.match(output[0] ?? '', /Saved recommendation \(likely relevant\): The official profile describes matching systems research\./);
    assert.equal(output.join('\n').includes('private search text'), false);
    assert.equal(calls.includes('fetch'), false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('read-only viewer sanitizes connection errors and reports the failure stage and safe code', async () => {
  const output: string[] = [];
  const succeeded = await runReadOnlyLeadViewer({
    async connect() { throw Object.assign(new Error('contains mongodb://user:secret@host'), { code: 'ETIMEOUT' }); },
    write(text) { output.push(text); },
  });
  assert.equal(succeeded, false);
  assert.deepEqual(output, ['Read failed at mongodb_connection: network_error: Network request failed. (ETIMEOUT)']);
  assert.equal(output.join('').includes('secret'), false);
});
