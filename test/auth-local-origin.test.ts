import assert from 'node:assert/strict';
import test from 'node:test';
import { createActionURL } from '../node_modules/@auth/core/lib/utils/env.js';
import { defaultCallbacks } from '../node_modules/@auth/core/lib/init.js';

test('Auth.js builds Google callback and post-login URLs from AUTH_URL, not the bind host', async () => {
  const authUrl = 'http://localhost:3000';
  const incomingHeaders = new Headers({ host: '0.0.0.0:3000' });
  const signInUrl = createActionURL(
    'signin',
    'http',
    incomingHeaders,
    { AUTH_URL: authUrl },
    { basePath: '/api/auth' },
  );

  assert.equal(signInUrl.origin, authUrl);
  assert.equal(signInUrl.pathname, '/api/auth/signin');
  assert.equal(
    new URL('/api/auth/callback/google', signInUrl).toString(),
    'http://localhost:3000/api/auth/callback/google',
  );
  assert.equal(
    await defaultCallbacks.redirect({ url: '/workspace', baseUrl: signInUrl.origin }),
    'http://localhost:3000/workspace',
  );
});
