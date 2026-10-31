import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMongoTestUri, getEnabledMongoTestUri } from './mongo-test-uri.ts';

const username = 'synthetic-user';
const password = 'synthetic-password';

test('accepts standard MongoDB URIs with multiple hosts and the exact test database', () => {
  const uri = `mongodb://${username}:${password}@shard-a.example.net:27017,shard-b.example.net:27017,shard-c.example.net:27017/gradreach_test?replicaSet=rs0&authSource=admin&tls=true`;
  assert.doesNotThrow(() => assertMongoTestUri(uri));
});

test('Mongo integration stays disabled unless the explicit test command opts in', () => {
  assert.equal(getEnabledMongoTestUri({ enabled: undefined, uri: 'mongodb://test.example/gradreach_test' }), undefined);
  assert.equal(getEnabledMongoTestUri({ enabled: 'false', uri: 'mongodb://test.example/gradreach_test' }), undefined);
  assert.equal(getEnabledMongoTestUri({ enabled: 'true', uri: 'mongodb://test.example/gradreach_test' }), 'mongodb://test.example/gradreach_test');
});

test('accepts MongoDB SRV URIs with the exact test database without DNS lookup', () => {
  const uri = `mongodb+srv://${username}:${password}@cluster.example.net/gradreach_test?authSource=admin&retryWrites=true&w=majority`;
  assert.doesNotThrow(() => assertMongoTestUri(uri));
});

test('rejects a URI for another database without including the URI or credentials in the error', () => {
  const uri = `mongodb://${username}:${password}@shard-a.example.net,shard-b.example.net/production`;
  assert.throws(() => assertMongoTestUri(uri), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'MONGODB_TEST_URI must target gradreach_test; URI details are hidden.');
    for (const secret of [uri, username, password, 'shard-a.example.net']) {
      assert.equal(error.message.includes(secret), false);
    }
    return true;
  });
});

test('rejects malformed MongoDB URIs with a generic message that hides input details', () => {
  const malformedUris = [
    `mongodb://${username}:${password}@[invalid-host/gradreach_test`,
    'mongodb://[::1/gradreach_test',
    'https://not-mongodb.example/gradreach_test',
  ];

  for (const uri of malformedUris) {
    assert.throws(() => assertMongoTestUri(uri), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'MONGODB_TEST_URI is malformed; URI details are hidden.');
      for (const secret of [uri, username, password, 'invalid-host']) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    });
  }
});
