import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runDiscoveryScheduler } from '../src/interfaces/discovery-scheduler.ts';

test('discovery scheduler stays disabled and never connects without the explicit worker opt-in', async () => {
  const previous = process.env.GRADREACH_DISCOVERY_SCHEDULER_ENABLED;
  let connections = 0;
  try {
    for (const setting of [undefined, 'false']) {
      if (setting === undefined) delete process.env.GRADREACH_DISCOVERY_SCHEDULER_ENABLED;
      else process.env.GRADREACH_DISCOVERY_SCHEDULER_ENABLED = setting;
      await runDiscoveryScheduler(async () => {
        connections += 1;
        throw new Error('mock connection should not be called while disabled');
      });
    }
    assert.equal(connections, 0);
  } finally {
    if (previous === undefined) delete process.env.GRADREACH_DISCOVERY_SCHEDULER_ENABLED;
    else process.env.GRADREACH_DISCOVERY_SCHEDULER_ENABLED = previous;
  }
});

test('the discovery loop records its heartbeat before spending a search', async () => {
  const source = await readFile(new URL('../src/interfaces/discovery-scheduler.ts', import.meta.url), 'utf8');
  const heartbeatAt = source.indexOf("pulseSchedulerHeartbeat(storage.repositories.schedulerHeartbeat, 'discovery')");
  const discoveryAt = source.indexOf('runAutomaticDiscovery({');
  assert.ok(heartbeatAt > 0, 'the loop should record a discovery heartbeat');
  assert.ok(discoveryAt > 0, 'the loop should still run automatic discovery');
  assert.ok(heartbeatAt < discoveryAt, 'the heartbeat must be written before the cycle spends provider credit');
});
