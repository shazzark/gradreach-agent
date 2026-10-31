import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { connectMongoStorage } from '../src/infrastructure/mongo-storage.ts';

test('storage cleanup preserves the original MongoDB connection error when close also fails', async () => {
  const originalError = Object.assign(new Error('synthetic MongoDB failure'), {
    name: 'MongoServerSelectionError',
    code: 'ETIMEOUT',
  });
  const closeError = new Error('Network request failed.');
  const connectDescriptor = Object.getOwnPropertyDescriptor(MongoClient.prototype, 'connect');
  const closeDescriptor = Object.getOwnPropertyDescriptor(MongoClient.prototype, 'close');

  Object.defineProperty(MongoClient.prototype, 'connect', {
    ...connectDescriptor,
    value: async function connect() { throw originalError; },
  });
  Object.defineProperty(MongoClient.prototype, 'close', {
    ...closeDescriptor,
    value: async function close() { throw closeError; },
  });

  try {
    await assert.rejects(
      connectMongoStorage('mongodb://127.0.0.1:27017/synthetic'),
      (error: unknown) => error === originalError,
    );
  } finally {
    if (connectDescriptor) Object.defineProperty(MongoClient.prototype, 'connect', connectDescriptor);
    if (closeDescriptor) Object.defineProperty(MongoClient.prototype, 'close', closeDescriptor);
  }
});
