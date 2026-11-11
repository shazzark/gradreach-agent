import { redirect } from 'next/navigation';
import { auth } from '../../auth.ts';
import { canStartGoogleSignIn, isOwnerSession } from '../../src/web/owner-access.ts';
import { startGoogleSignIn } from './actions.ts';
import { DEFAULT_WORKSPACE_PATH, safeWorkspaceReturnPath } from '../../src/web/owner-access.ts';
import { ui } from '../../src/web/ui-classes.ts';

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const session = await auth();
  if (isOwnerSession(session, process.env.GRADREACH_OWNER_EMAIL)) redirect(DEFAULT_WORKSPACE_PATH);
  const query = await searchParams;
  const callbackUrl = safeWorkspaceReturnPath(query.callbackUrl);
  const configured = canStartGoogleSignIn({
    ownerEmail: process.env.GRADREACH_OWNER_EMAIL,
    googleClientId: process.env.AUTH_GOOGLE_ID,
    googleClientSecret: process.env.AUTH_GOOGLE_SECRET,
    authSecret: process.env.AUTH_SECRET,
    trustHost: process.env.AUTH_TRUST_HOST,
  });
  return <main className="mx-auto mt-[10vh] w-full max-w-[480px] px-4 sm:px-6">
    <section className={`${ui.panel} p-6 sm:p-9`}>
      <p className={ui.eyebrow}>Private owner sign-in</p><h1 className="my-2 font-display text-3xl font-bold tracking-tight text-ink">GradReach</h1>
      <p className="text-muted">Access is restricted to the single owner Google account configured by the site administrator. New accounts and invitations are disabled.</p>
      {configured ? <form action={startGoogleSignIn} className="mt-5"><input type="hidden" name="callbackUrl" value={callbackUrl}/><button className={ui.primaryButton} type="submit">Continue with Google</button></form> : <p className={ui.warning}>Owner-only sign-in is unavailable until the server-side owner email and Google OAuth settings are configured.</p>}
      <p className={`${ui.muted} mt-5 text-sm`}>Google sign-in uses identity scopes only. Gmail authorization is a separate step and is not granted here.</p>
    </section>
  </main>;
}
