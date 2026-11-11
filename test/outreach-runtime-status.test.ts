import assert from 'node:assert/strict';
import test from 'node:test';
import { getOutreachRuntimeStatus } from '../src/web/outreach-runtime-status.ts';

test('delivery runtime remains disabled when the server opt-in is off, even if the queue is unpaused', () => {
  assert.deepEqual(getOutreachRuntimeStatus({ sendingEnabled: false, control: { paused: false } }), {
    state: 'disabled',
    label: 'Automatic Gmail delivery is disabled',
    detail: 'The server opt-in is off. The outreach worker exits without connecting to MongoDB.',
  });
});

test('saved pause blocks delivery when the server opt-in is enabled', () => {
  assert.equal(getOutreachRuntimeStatus({ sendingEnabled: true, control: { paused: true } }).state, 'paused');
});

test('status clearly identifies when an enabled worker could deliver queued approved drafts', () => {
  const status = getOutreachRuntimeStatus({ sendingEnabled: true, control: { paused: false } });
  assert.equal(status.state, 'armed');
  assert.match(status.detail, /separate outreach worker is running/);
});
