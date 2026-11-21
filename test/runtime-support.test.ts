import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MINIMUM_NODE_MAJOR, RuntimeSupportError, assertSupportedRuntime, unsupportedRuntime,
} from '../src/infrastructure/runtime-support.ts';

const SOURCE_MODULE = 'file:///C:/repo/src/interfaces/outreach-scheduler.ts';
const BUILT_MODULE = 'file:///C:/repo/dist/interfaces/outreach-scheduler.js';
const BUNDLED_MODULE = 'file:///C:/repo/.next/server/chunks/42.js';

test('compiled entry points run on every supported Node.js version without experimental flags', () => {
  assert.equal(MINIMUM_NODE_MAJOR, 22);
  assert.equal(unsupportedRuntime({ nodeVersion: '22.13.0', moduleUrl: BUILT_MODULE }), undefined);
  assert.equal(unsupportedRuntime({ nodeVersion: '24.1.0', moduleUrl: BUILT_MODULE }), undefined);
});

test('an unsupported Node.js version fails loudly with the running and required version', () => {
  const problem = unsupportedRuntime({ nodeVersion: '20.19.0', moduleUrl: BUILT_MODULE });
  assert.ok(problem instanceof RuntimeSupportError);
  assert.equal(problem.code, 'node_version_unsupported');
  assert.match(problem.message, /requires Node\.js 22 or newer/);
  assert.match(problem.message, /20\.19\.0/);
  assert.equal(unsupportedRuntime({ nodeVersion: 'not-a-version', moduleUrl: BUILT_MODULE })?.code, 'node_version_unsupported');
});

test('TypeScript sources need type stripping from the runtime or an explicit flag', () => {
  assert.equal(unsupportedRuntime({ nodeVersion: '22.18.0', typeScriptFeature: 'strip', execArgv: [], moduleUrl: SOURCE_MODULE }), undefined);
  assert.equal(unsupportedRuntime({ nodeVersion: '22.13.0', typeScriptFeature: false, execArgv: ['--experimental-strip-types'], moduleUrl: SOURCE_MODULE }), undefined);
  assert.equal(unsupportedRuntime({ nodeVersion: '22.13.0', typeScriptFeature: false, nodeOptions: '--experimental-strip-types', moduleUrl: SOURCE_MODULE }), undefined);
  const problem = unsupportedRuntime({ nodeVersion: '22.13.0', typeScriptFeature: false, execArgv: [], nodeOptions: '', moduleUrl: SOURCE_MODULE });
  assert.equal(problem?.code, 'typescript_runtime_unavailable');
  assert.match(problem?.message ?? '', /22\.18 or newer/);
});

test('Next.js bundles are left alone so website imports cannot fail on this guard', () => {
  assert.equal(unsupportedRuntime({ nodeVersion: '20.19.0', typeScriptFeature: false, moduleUrl: BUNDLED_MODULE }), undefined);
});

test('the guarded entry points accept the runtime the test suite runs on', () => {
  assert.equal(assertSupportedRuntime({ moduleUrl: SOURCE_MODULE }), undefined);
  assert.equal(assertSupportedRuntime({ moduleUrl: BUILT_MODULE }), undefined);
});
