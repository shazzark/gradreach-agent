import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runOutreachScheduler } from '../src/interfaces/outreach-scheduler.ts';

test('outreach scheduler stays disabled and does not connect to MongoDB by default', async () => {
  const previous = process.env.OUTREACH_SENDING_ENABLED;
  let connections = 0;
  try {
    for (const setting of [undefined, 'false']) {
      if (setting === undefined) delete process.env.OUTREACH_SENDING_ENABLED;
      else process.env.OUTREACH_SENDING_ENABLED = setting;
      await runOutreachScheduler(async () => {
        connections += 1;
        throw new Error('mock connection should not be called while disabled');
      });
    }
    assert.equal(connections, 0);
  } finally {
    if (previous === undefined) delete process.env.OUTREACH_SENDING_ENABLED;
    else process.env.OUTREACH_SENDING_ENABLED = previous;
  }
});

test('the outreach loop records its heartbeat before any delivery attempt', async () => {
  const source = await readFile(new URL('../src/interfaces/outreach-scheduler.ts', import.meta.url), 'utf8');
  const heartbeatAt = source.indexOf("pulseSchedulerHeartbeat(storage.repositories.schedulerHeartbeat, 'outreach')");
  const deliveryAt = source.indexOf('delivery.deliverNext()');
  assert.ok(heartbeatAt > 0, 'the loop should record an outreach heartbeat');
  assert.ok(deliveryAt > 0, 'the loop should still deliver queued drafts');
  assert.ok(heartbeatAt < deliveryAt, 'the heartbeat must be written before delivery so a slow send cannot look dead');
  assert.match(source, /while \(!stop\) \{/);
});
