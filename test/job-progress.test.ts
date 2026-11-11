import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encode } from 'next-auth/jwt';
import { Server } from 'socket.io';
import { io as socketClient } from 'socket.io-client';
import { parseJobProgressEvent } from '../src/domain/job-progress.ts';
import { publishJobProgress, subscribeToJobProgress } from '../src/infrastructure/job-progress-bus.ts';
import { attachJobProgressSocket } from '../src/infrastructure/socket-progress-server.ts';
import { isAuthorizedSocketHandshake, isSocketOwnerToken, isTrustedSocketOrigin } from '../src/web/socket-progress-auth.ts';

const event = {
  jobId: 'job_123', kind: 'discovery', state: 'running', stage: 'searching', completed: 1, total: 3,
  updatedAt: '2026-11-07T12:00:00.000Z',
} as const;

test('progress events accept only bounded status fields, never record or content payloads', () => {
  assert.deepEqual(parseJobProgressEvent(event), event);
  assert.throws(() => parseJobProgressEvent({ ...event, professorName: 'private data' }), /Unsupported job progress field/);
  assert.throws(() => parseJobProgressEvent({ ...event, result: { email: 'private data' } }), /Unsupported job progress field/);
  assert.throws(() => parseJobProgressEvent({ ...event, completed: 4 }), /exceeds its total/);
  assert.throws(() => parseJobProgressEvent({ ...event, jobId: 'bad id' }), /Invalid job progress ID/);
});

test('the progress bus publishes validated transient events and supports unsubscribe', () => {
  const received: unknown[] = [];
  const unsubscribe = subscribeToJobProgress((value) => { received.push(value); });
  publishJobProgress(event);
  unsubscribe();
  publishJobProgress({ ...event, stage: 'completed', state: 'completed' });
  assert.deepEqual(received, [event]);
});

test('owner socket authentication requires the signed owner marker and exact configured email', () => {
  assert.equal(isSocketOwnerToken({ ownerAllowed: true, email: 'owner@example.edu' }, 'owner@example.edu'), true);
  assert.equal(isSocketOwnerToken({ ownerAllowed: true, email: 'other@example.edu' }, 'owner@example.edu'), false);
  assert.equal(isSocketOwnerToken({ email: 'owner@example.edu' }, 'owner@example.edu'), false);
  assert.equal(isSocketOwnerToken(null, 'owner@example.edu'), false);
  assert.equal(isSocketOwnerToken({ ownerAllowed: true, email: 'owner@example.edu' }, undefined), false);
});

test('socket handshake origin is same-origin and production requires its canonical HTTPS URL', () => {
  assert.equal(isTrustedSocketOrigin('https://gradreach.example', 'https://gradreach.example', 'gradreach.example', undefined, true), true);
  assert.equal(isTrustedSocketOrigin('https://attacker.example', 'https://gradreach.example', 'gradreach.example', undefined, true), false);
  assert.equal(isTrustedSocketOrigin('http://localhost:3000', undefined, 'localhost:3000', undefined, false), true);
  assert.equal(isTrustedSocketOrigin('http://localhost:3000', undefined, 'localhost:3000', undefined, true), false);
  assert.equal(isTrustedSocketOrigin(undefined, 'https://gradreach.example', 'gradreach.example', undefined, true), false);
});

test('socket handshake decodes the same encrypted Auth.js owner session cookie', async () => {
  const secret = 'test-only-secret-for-socket-auth';
  const cookieName = '__Secure-authjs.session-token';
  const jwt = await encode({
    secret,
    salt: cookieName,
    token: { email: 'owner@example.edu', ownerAllowed: true },
    maxAge: 60,
  });
  const headers = {
    origin: 'https://gradreach.example',
    host: 'gradreach.example',
    cookie: `${cookieName}=${jwt}`,
  };
  assert.equal(await isAuthorizedSocketHandshake({
    headers, ownerEmail: 'owner@example.edu', secret, authUrl: 'https://gradreach.example', isProduction: true,
  }), true);
  assert.equal(await isAuthorizedSocketHandshake({
    headers, ownerEmail: 'other@example.edu', secret, authUrl: 'https://gradreach.example', isProduction: true,
  }), false);
  assert.equal(await isAuthorizedSocketHandshake({
    headers: { ...headers, origin: 'https://attacker.example' }, ownerEmail: 'owner@example.edu', secret,
    authUrl: 'https://gradreach.example', isProduction: true,
  }), false);
});

test('authorized owner receives only the transient progress event over Socket.IO', async () => {
  const httpServer = createServer();
  const io = new Server(httpServer, { path: '/api/socket.io' });
  const secret = 'test-only-secret-for-socket-auth';
  const cookieName = '__Secure-authjs.session-token';
  const jwt = await encode({ secret, salt: cookieName, token: { email: 'owner@example.edu', ownerAllowed: true }, maxAge: 60 });
  const unsubscribe = attachJobProgressSocket({
    io, ownerEmail: 'owner@example.edu', secret, authUrl: 'https://gradreach.example', isProduction: true,
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const { port } = httpServer.address() as AddressInfo;
  const client = socketClient(`http://127.0.0.1:${port}`, {
    path: '/api/socket.io',
    transports: ['websocket'],
    extraHeaders: {
      Origin: 'https://gradreach.example',
      Cookie: `${cookieName}=${jwt}`,
    },
    reconnection: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
      setTimeout(() => reject(new Error('Socket.IO connection timed out')), 3000).unref();
    });
    const received = new Promise<unknown>((resolve, reject) => {
      client.once('job:progress', resolve);
      setTimeout(() => reject(new Error('Progress event timed out')), 3000).unref();
    });
    publishJobProgress(event);
    assert.deepEqual(await received, event);
  } finally {
    client.disconnect();
    unsubscribe();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
