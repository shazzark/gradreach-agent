import assert from 'node:assert/strict';
import test from 'node:test';
import { canStartGoogleSignIn, GOOGLE_SIGN_IN_SCOPES, isAllowedGoogleSignIn, isOwnerSession, isVerifiedGoogleOwner } from '../src/web/owner-access.ts';
import { safeOfficialSourceUrl } from '../src/web/safe-source-url.ts';

const ownerEmail = 'owner@example.com';

test('only a verified Google identity with the configured exact owner email is accepted', () => {
  assert.equal(isVerifiedGoogleOwner({ email: ownerEmail, email_verified: true }, ownerEmail), true);
  assert.equal(isVerifiedGoogleOwner({ email: 'other@example.com', email_verified: true }, ownerEmail), false);
  assert.equal(isVerifiedGoogleOwner({ email: ownerEmail, email_verified: false }, ownerEmail), false);
  assert.equal(isVerifiedGoogleOwner({ email: ownerEmail }, ownerEmail), false);
  assert.equal(isAllowedGoogleSignIn('google', { email: ownerEmail, email_verified: true }, ownerEmail), true);
  assert.equal(isAllowedGoogleSignIn('github', { email: ownerEmail, email_verified: true }, ownerEmail), false);
  assert.equal(GOOGLE_SIGN_IN_SCOPES, 'openid email profile');
  assert.doesNotMatch(GOOGLE_SIGN_IN_SCOPES, /gmail/i);
});

test('owner sessions fail closed when the configured owner email is missing or differs', () => {
  const ownerSession = { user: { email: ownerEmail, isOwner: true } };
  assert.equal(isOwnerSession(ownerSession, ownerEmail), true);
  assert.equal(isOwnerSession({ user: { email: 'other@example.com', isOwner: true } }, ownerEmail), false);
  assert.equal(isOwnerSession({ user: { email: ownerEmail, isOwner: false } }, ownerEmail), false);
  assert.equal(isOwnerSession(ownerSession, undefined), false);
  assert.equal(isOwnerSession(ownerSession, 'not-an-email'), false);
});

test('Google sign-in is unavailable unless owner, provider credentials, and session secret exist', () => {
  const complete = { ownerEmail, googleClientId: 'client-id', googleClientSecret: 'client-secret', authSecret: 'random-secret', trustHost: 'true' };
  assert.equal(canStartGoogleSignIn(complete), true);
  assert.equal(canStartGoogleSignIn({ ...complete, ownerEmail: undefined }), false);
  assert.equal(canStartGoogleSignIn({ ...complete, googleClientId: undefined }), false);
  assert.equal(canStartGoogleSignIn({ ...complete, googleClientSecret: undefined }), false);
  assert.equal(canStartGoogleSignIn({ ...complete, authSecret: undefined }), false);
  assert.equal(canStartGoogleSignIn({ ...complete, trustHost: undefined }), false);
});

test('source links remove query credentials and reject unsafe URL schemes', () => {
  assert.equal(safeOfficialSourceUrl('https://university.example/profile?token=private#bio'), 'https://university.example/profile');
  assert.equal(safeOfficialSourceUrl('https://user:password@university.example/profile'), undefined);
  assert.equal(safeOfficialSourceUrl('javascript:alert(1)'), undefined);
});
