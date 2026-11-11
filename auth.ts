import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { GOOGLE_SIGN_IN_SCOPES, isAllowedGoogleSignIn, isOwnerSession, isPublicWebsitePath, isVerifiedGoogleOwner } from './src/web/owner-access.ts';

export { GOOGLE_SIGN_IN_SCOPES };

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...(process.env.AUTH_SECRET ? { secret: process.env.AUTH_SECRET } : {}),
  trustHost: process.env.AUTH_TRUST_HOST === 'true',
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  pages: { signIn: '/sign-in' },
  providers: [Google({ authorization: { params: { scope: GOOGLE_SIGN_IN_SCOPES } } })],
  callbacks: {
    async signIn({ account, profile }) {
      return isAllowedGoogleSignIn(account?.provider, profile, process.env.GRADREACH_OWNER_EMAIL);
    },
    async jwt({ token, account, profile }) {
      if (account?.provider === 'google') {
        token.ownerAllowed = isVerifiedGoogleOwner(profile, process.env.GRADREACH_OWNER_EMAIL);
      }
      token.ownerAllowed = token.ownerAllowed === true
        && isOwnerSession({ user: { email: token.email, isOwner: true } }, process.env.GRADREACH_OWNER_EMAIL);
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        isOwner: token.ownerAllowed === true
          && isOwnerSession({ user: { email: token.email, isOwner: true } }, process.env.GRADREACH_OWNER_EMAIL),
      };
      return session;
    },
    authorized({ auth: session, request }) {
      const pathname = request.nextUrl.pathname;
      if (isPublicWebsitePath(pathname)) return true;
      if (isOwnerSession(session, process.env.GRADREACH_OWNER_EMAIL)) return true;
      if (pathname.startsWith('/api/')) {
        return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
      }
      return false;
    },
  },
});
