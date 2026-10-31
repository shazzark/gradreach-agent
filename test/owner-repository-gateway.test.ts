import assert from 'node:assert/strict';
import test from 'node:test';
import { OwnerAccessDenied, withOwnerRepositories } from '../src/web/owner-repository-gateway.ts';
import type { GradReachRepositories } from '../src/infrastructure/mongo-storage.ts';

const ownerEmail = 'owner@example.com';
const repositories = {} as GradReachRepositories;

test('unauthenticated and non-owner calls cannot connect or access repositories', async () => {
  for (const session of [null, { user: { email: 'other@example.com', isOwner: true } }]) {
    let connects = 0;
    let operations = 0;
    await assert.rejects(withOwnerRepositories({
      getSession: async () => session,
      ownerEmail,
      async connect() { connects += 1; throw new Error('must not connect'); },
    }, async () => { operations += 1; return 'private'; }), OwnerAccessDenied);
    assert.equal(connects, 0);
    assert.equal(operations, 0);
  }
});

test('missing owner configuration fails closed before the database connection', async () => {
  let connects = 0;
  await assert.rejects(withOwnerRepositories({
    getSession: async () => ({ user: { email: ownerEmail, isOwner: true } }),
    ownerEmail: undefined,
    async connect() { connects += 1; throw new Error('must not connect'); },
  }, async () => 'private'), OwnerAccessDenied);
  assert.equal(connects, 0);
});

test('verified owner access invokes the operation and always closes the request database client', async () => {
  let connects = 0;
  let closes = 0;
  let received: GradReachRepositories | undefined;
  const result = await withOwnerRepositories({
    getSession: async () => ({ user: { email: ownerEmail, isOwner: true } }),
    ownerEmail,
    async connect() {
      connects += 1;
      return { repositories, client: undefined as never, async close() { closes += 1; } };
    },
  }, async (value) => { received = value; return 'authorized result'; });
  assert.equal(result, 'authorized result');
  assert.equal(connects, 1);
  assert.equal(closes, 1);
  assert.equal(received, repositories);
});

test('request database client closes even if an authorized repository operation fails', async () => {
  let closes = 0;
  await assert.rejects(withOwnerRepositories({
    getSession: async () => ({ user: { email: ownerEmail, isOwner: true } }),
    ownerEmail,
    async connect() { return { repositories, client: undefined as never, async close() { closes += 1; } }; },
  }, async () => { throw new Error('operation failed'); }), /operation failed/);
  assert.equal(closes, 1);
});
