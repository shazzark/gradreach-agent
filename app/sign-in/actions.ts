'use server';

import { signIn } from '../../auth.ts';
import { canStartGoogleSignIn } from '../../src/web/owner-access.ts';

export async function startGoogleSignIn(): Promise<void> {
  if (!canStartGoogleSignIn({
    ownerEmail: process.env.GRADREACH_OWNER_EMAIL,
    googleClientId: process.env.AUTH_GOOGLE_ID,
    googleClientSecret: process.env.AUTH_GOOGLE_SECRET,
    authSecret: process.env.AUTH_SECRET,
    trustHost: process.env.AUTH_TRUST_HOST,
  })) throw new Error('Private website sign-in is not configured');
  await signIn('google', { redirectTo: '/' });
}
