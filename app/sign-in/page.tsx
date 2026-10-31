import { redirect } from 'next/navigation';
import { auth } from '../../auth.ts';
import { canStartGoogleSignIn, isOwnerSession } from '../../src/web/owner-access.ts';
import { startGoogleSignIn } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  const session = await auth();
  if (isOwnerSession(session, process.env.GRADREACH_OWNER_EMAIL)) redirect('/');
  const configured = canStartGoogleSignIn({
    ownerEmail: process.env.GRADREACH_OWNER_EMAIL,
    googleClientId: process.env.AUTH_GOOGLE_ID,
    googleClientSecret: process.env.AUTH_GOOGLE_SECRET,
    authSecret: process.env.AUTH_SECRET,
    trustHost: process.env.AUTH_TRUST_HOST,
  });
  return <main className="panel signin">
    <p className="eyebrow">Private owner sign-in</p><h1>GradReach</h1>
    <p className="subtle">Access is restricted to the single owner Google account configured by the site administrator. New accounts and invitations are disabled.</p>
    {configured ? <form action={startGoogleSignIn}><button type="submit">Continue with Google</button></form> : <p className="warning">Owner-only sign-in is unavailable until the server-side owner email and Google OAuth settings are configured.</p>}
    <p className="muted">Google sign-in uses identity scopes only. Gmail authorization is a separate step and is not granted here.</p>
  </main>;
}
