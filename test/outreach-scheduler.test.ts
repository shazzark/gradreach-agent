import assert from 'node:assert/strict';
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
