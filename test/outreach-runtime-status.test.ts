import assert from 'node:assert/strict';
import test from 'node:test';
import { getOutreachRuntimeStatus } from '../src/web/outreach-runtime-status.ts';

const now = '2026-11-20T12:00:00Z';
const live = { lastHeartbeatAt: '2026-11-20T11:59:30Z' };
const stale = { lastHeartbeatAt: '2026-11-20T11:57:00Z' };

test('delivery runtime remains disabled when the server opt-in is off, even if the queue is unpaused and the worker is dead', () => {
  assert.deepEqual(getOutreachRuntimeStatus({ sendingEnabled: false, control: { paused: false }, heartbeat: stale, now }), {
    state: 'disabled',
    label: 'Automatic Gmail delivery is disabled',
    detail: 'The server opt-in is off. The outreach worker exits without connecting to MongoDB.',
  });
});

test('saved pause blocks delivery while the worker is still checking in', () => {
  assert.equal(getOutreachRuntimeStatus({ sendingEnabled: true, control: { paused: true }, heartbeat: live, now }).state, 'paused');
});

test('status clearly identifies when an enabled worker could deliver queued approved drafts', () => {
  const status = getOutreachRuntimeStatus({ sendingEnabled: true, control: { paused: false }, heartbeat: live, now });
  assert.equal(status.state, 'armed');
  assert.match(status.detail, /checked in 30 seconds ago/);
});

test('a heartbeat older than two minutes reports the worker as down', () => {
  const status = getOutreachRuntimeStatus({ sendingEnabled: true, control: { paused: false }, heartbeat: stale, now });
  assert.equal(status.state, 'worker_down');
  assert.equal(status.label, 'Worker is not running');
  assert.match(status.detail, /3 minutes ago/);
  assert.match(status.detail, /phase-5-worker-supervision\.md/);
});

test('a heartbeat exactly two minutes old still counts as a live worker', () => {
  const status = getOutreachRuntimeStatus({
    sendingEnabled: true,
    control: { paused: false },
    heartbeat: { lastHeartbeatAt: '2026-11-20T11:58:00Z' },
    now,
  });
  assert.equal(status.state, 'armed');
});

test('a worker that never recorded a heartbeat is reported as down instead of assumed running', () => {
  const status = getOutreachRuntimeStatus({ sendingEnabled: true, control: { paused: false }, now });
  assert.equal(status.state, 'worker_down');
  assert.match(status.detail, /No scheduler heartbeat has ever been recorded/);
});

test('a dead worker is reported instead of the pause control, because resuming would deliver nothing', () => {
  assert.equal(getOutreachRuntimeStatus({ sendingEnabled: true, control: { paused: true }, heartbeat: stale, now }).state, 'worker_down');
});
