import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULER_HEARTBEAT_STALE_MS, schedulerHeartbeatStatus } from '../src/domain/scheduler-heartbeat.ts';
import { SchedulerHeartbeatRepository } from '../src/infrastructure/mongo-storage.ts';
import { pulseSchedulerHeartbeat } from '../src/interfaces/scheduler-heartbeat-pulse.ts';

const now = '2026-11-20T12:00:00Z';

/** In-memory stand-in for the two collection calls the heartbeat repository makes, so no database is required. */
function fakeHeartbeatCollection() {
  const documents = new Map<string, { _id: string; lastHeartbeatAt: string; updatedAt: Date }>();
  const writes: string[] = [];
  const collection = {
    async updateOne(filter: { _id: string }, update: { $set: { lastHeartbeatAt: string; updatedAt: Date } }) {
      writes.push(filter._id);
      documents.set(filter._id, { _id: filter._id, ...update.$set });
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
    },
    async findOne(filter: { _id: string }) { return documents.get(filter._id); },
  };
  return { collection, documents, writes };
}

test('the stale threshold is two minutes because both workers tick every sixty seconds', () => {
  assert.equal(SCHEDULER_HEARTBEAT_STALE_MS, 120_000);
});

test('a heartbeat inside the threshold is live and one beyond it is stale', () => {
  assert.deepEqual(schedulerHeartbeatStatus({ lastHeartbeatAt: '2026-11-20T11:59:00Z' }, now), {
    state: 'live', ageMs: 60_000, lastHeartbeatAt: '2026-11-20T11:59:00.000Z',
  });
  assert.deepEqual(schedulerHeartbeatStatus({ lastHeartbeatAt: '2026-11-20T11:58:00Z' }, now), {
    state: 'live', ageMs: 120_000, lastHeartbeatAt: '2026-11-20T11:58:00.000Z',
  });
  assert.equal(schedulerHeartbeatStatus({ lastHeartbeatAt: '2026-11-20T11:57:59Z' }, now).state, 'stale');
});

test('a missing or unreadable heartbeat is reported as missing rather than assumed healthy', () => {
  assert.deepEqual(schedulerHeartbeatStatus(undefined, now), { state: 'missing' });
  assert.deepEqual(schedulerHeartbeatStatus({ lastHeartbeatAt: 'not a timestamp' }, now), { state: 'missing' });
});

test('clock skew floors the reported age at zero instead of returning a negative value', () => {
  const status = schedulerHeartbeatStatus({ lastHeartbeatAt: '2026-11-20T12:00:30Z' }, now);
  assert.equal(status.state, 'live');
  assert.equal(status.ageMs, 0);
});

test('an invalid reference time is rejected instead of silently classified', () => {
  assert.throws(() => schedulerHeartbeatStatus({ lastHeartbeatAt: now }, 'yesterday'), /now must be a valid date/);
});

test('the heartbeat repository keeps one document per worker and reads each worker back independently', async () => {
  const { collection, documents } = fakeHeartbeatCollection();
  const repository = new SchedulerHeartbeatRepository(collection as never);
  await repository.updateSchedulerHeartbeat('outreach', '2026-11-20T12:00:00Z');
  await repository.updateSchedulerHeartbeat('discovery', '2026-11-20T12:00:30Z');
  assert.deepEqual([...documents.keys()], ['scheduler-heartbeat:outreach', 'scheduler-heartbeat:discovery']);
  assert.deepEqual(await repository.getSchedulerHeartbeat('outreach'), { lastHeartbeatAt: '2026-11-20T12:00:00.000Z' });
  assert.deepEqual(await repository.getSchedulerHeartbeat('discovery'), { lastHeartbeatAt: '2026-11-20T12:00:30.000Z' });
});

test('the heartbeat repository reports no record instead of inventing one for a worker that never checked in', async () => {
  const { collection } = fakeHeartbeatCollection();
  const repository = new SchedulerHeartbeatRepository(collection as never);
  assert.equal(await repository.getSchedulerHeartbeat('outreach'), undefined);
});

test('the heartbeat repository rejects an unknown worker and an invalid instant before writing', async () => {
  const { collection, writes } = fakeHeartbeatCollection();
  const repository = new SchedulerHeartbeatRepository(collection as never);
  await assert.rejects(() => repository.updateSchedulerHeartbeat('mailer' as never), /known scheduler worker/);
  await assert.rejects(() => repository.updateSchedulerHeartbeat('outreach', 'not a timestamp'), /lastHeartbeatAt must be a valid date/);
  assert.deepEqual(writes, []);
});

test('the scheduler pulse writes the tick instant for its own worker', async () => {
  const writes: Array<[string, string]> = [];
  const recorded = await pulseSchedulerHeartbeat({
    async updateSchedulerHeartbeat(worker, lastHeartbeatAt) { writes.push([worker, lastHeartbeatAt ?? '']); },
  }, 'outreach', new Date('2026-11-20T12:00:00Z'));
  assert.equal(recorded, true);
  assert.deepEqual(writes, [['outreach', '2026-11-20T12:00:00.000Z']]);
});

test('a failed heartbeat write is reported without taking the worker loop down', async () => {
  const recorded = await pulseSchedulerHeartbeat({
    async updateSchedulerHeartbeat() { throw new Error('MongoDB is unreachable'); },
  }, 'discovery');
  assert.equal(recorded, false);
});
