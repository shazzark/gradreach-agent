import test from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateEvidenceTriage, ProfessorCandidate } from '../src/domain/outreach-queue.ts';
import { runReadOnlyLeadViewer } from '../src/interfaces/view-undecided-professor-leads.ts';

const lead: ProfessorCandidate = {
  id: 'professor-1', name: 'Dr Example | Example University profile', professorName: 'Dr Example', institution: 'Example University', country: '',
  leadType: 'professor_profile', officialProfileUrl: 'https://university.example.edu/professor',
  officialEmail: 'professor@university.example.edu', emailSourceUrl: 'https://university.example.edu/professor',
  discoveryEvidence: [
    { kind: 'professor-profile', sourceUrl: 'https://university.example.edu/professor', excerpt: 'Dr Example researches reliable systems.', quote: 'Dr Example researches reliable systems.', retrievedAt: '2026-10-30T12:00:00.000Z', verification: 'unverified', region: 'Exampleland', query: 'private search text' },
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
  const { professorName: _professorName, officialProfileUrl: _profileUrl, officialEmail: _email, ...generalLeadBase } = lead;
  const generalLead: ProfessorCandidate = {
    ...generalLeadBase,
    id: 'directory',
    name: 'Ravi Iyer | Faculty directory',
    leadType: 'school',
    discoveryEvidence: [{ kind: 'official-page', sourceUrl: 'https://university.example.edu/faculty', excerpt: 'Faculty directory.', retrievedAt: '2026-10-30T12:00:00.000Z', verification: 'unverified', region: 'Exampleland', query: 'private search text' }],
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls.push('fetch'); throw new Error('External provider call'); }) as typeof fetch;
  try {
    const succeeded = await runReadOnlyLeadViewer({
      connect: async () => ({
        get repositories() {
          return new Proxy({
            candidates: { async list() { calls.push('candidates.list'); return [
              lead,
              generalLead,
              { ...lead, id: 'accepted', discoveryReview: { decision: 'accepted' as const, reviewedAt: '2026-10-30T12:00:00.000Z' } },
            ]; } },
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
    assert.match(output.join('\n'), /Individual professor profiles needing review: 1/);
    assert.match(output.join('\n'), /Lead\/page title: Dr Example \| Example University profile \| Professor: Dr Example/);
    assert.match(output.join('\n'), /Country: Unknown/);
    assert.match(output.join('\n'), /Supporting quote: "Dr Example researches reliable systems\."/);
    assert.match(output.join('\n'), /Official email \[unverified\]: professor@university\.example\.edu/);
    assert.match(output.join('\n'), /Saved recommendation \(likely relevant\): The official profile describes matching systems research\./);
    assert.match(output.join('\n'), /General or unclassified leads needing review: 1/);
    assert.match(output.join('\n'), /Lead\/page title: Ravi Iyer \| Faculty directory \| directory/);
    assert.match(output.join('\n'), /Professor: Not established from saved profile evidence/);
    assert.match(output.join('\n'), /official-page: https:\/\/university\.example\.edu\/faculty/);
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
  assert.deepEqual(output, ['Read failed at mongodb_connection: timeout: Request timed out. [error=Error code=ETIMEOUT]']);
  assert.equal(output.join('').includes('secret'), false);
});

test('read-only viewer reports safe MongoDB diagnostics and excludes connection secrets and TXT data', async () => {
  const output: string[] = [];
  const failure = Object.assign(new Error('mongodb+srv://user:password@atlas.example/db?token=private TXT=private-txt'), {
    name: 'MongoServerSelectionError',
    code: 'ETIMEOUT',
    syscall: 'querySrv',
    reason: {
      servers: new Map([
        ['atlas-1.example', {
          type: 'Unknown',
          address: 'mongodb://user:password@atlas-1.example',
          error: Object.assign(new Error('mongodb://user:password@atlas.example/db?token=private TXT=private-txt'), {
            name: 'MongoNetworkError',
            code: 'EHOSTUNREACH',
            syscall: 'connect',
            txtRecord: 'private-txt',
          }),
        }],
        ['atlas-2.example', { type: 'RSPrimary', address: 'mongodb://user:password@atlas-2.example' }],
      ]),
    },
  });
  const succeeded = await runReadOnlyLeadViewer({
    async connect() { throw failure; },
    write(text) { output.push(text); },
  });

  assert.equal(succeeded, false);
  assert.deepEqual(output, [
    'Read failed at mongodb_connection: timeout: Request timed out. [error=MongoServerSelectionError code=ETIMEOUT cause=MongoNetworkError causeCode=EHOSTUNREACH syscall=querySrv servers=RSPrimary,Unknown]',
  ]);
  for (const secret of ['password', 'token=private', 'private-txt', 'atlas-1.example']) {
    assert.equal(output.join('\n').includes(secret), false);
  }
});

test('read-only viewer distinguishes an Atlas server error and redacts server details', async () => {
  const output: string[] = [];
  const failure = Object.assign(new Error('mongodb://user:password@atlas.example/db?token=private'), {
    name: 'MongoServerError',
    codeName: 'AtlasError',
    code: 8000,
    cause: Object.assign(new Error('private address and credentials'), {
      code: 'ECONNRESET',
      syscall: 'connect',
    }),
    reason: {
      servers: new Map([
        ['atlas.example', { type: 'Unknown', address: 'atlas.example:27017' }],
        ['router.example', { type: 'Mongos', address: 'router.example:27017' }],
      ]),
    },
  });

  const succeeded = await runReadOnlyLeadViewer({
    async connect() { throw failure; },
    write(text) { output.push(text); },
  });

  assert.equal(succeeded, false);
  assert.deepEqual(output, [
    'Read failed at mongodb_connection: mongodb_server_error: MongoDB server returned an error. [error=MongoServerError codeName=AtlasError code=8000 category=other_atlas_error cause=Error causeCode=ECONNRESET syscall=connect servers=Mongos,Unknown]',
  ]);
  for (const secret of ['password', 'token=private', 'atlas.example', 'router.example']) {
    assert.equal(output.join('\n').includes(secret), false);
  }
});

test('read-only viewer classifies Atlas code 8000 messages without exposing their contents', async () => {
  const cases = [
    ['authentication_failed', "Authentication failed for private-user with password=hidden mongodb://private@atlas.example"] ,
    ['authorization_denied', 'Not authorized on private-db to execute command with token=hidden'],
    ['network_access_denied', 'IP address 192.0.2.44 is not allowed to access this cluster'],
    ['other_atlas_error', 'Atlas internal detail includes mongodb://private@atlas.example and secret text'],
  ] as const;

  for (const [category, message] of cases) {
    const output: string[] = [];
    const failure = Object.assign(new Error(message), {
      name: 'MongoServerError',
      codeName: 'AtlasError',
      code: 8000,
    });
    const succeeded = await runReadOnlyLeadViewer({
      async connect() { throw failure; },
      write(text) { output.push(text); },
    });

    assert.equal(succeeded, false);
    assert.match(output[0] ?? '', new RegExp(`mongodb_server_error: MongoDB server returned an error\\. \\[error=MongoServerError codeName=AtlasError code=8000 category=${category}\\]`));
    for (const secret of ['private-user', 'hidden', 'private-db', '192.0.2.44', 'atlas.example', 'secret text']) {
      assert.equal(output.join('\n').includes(secret), false);
    }
  }
});
