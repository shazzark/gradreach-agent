export interface GoogleOwnerProfile {
  email?: unknown;
  email_verified?: unknown;
}

export interface OwnerSession {
  user?: {
    email?: string | null | undefined;
    isOwner?: boolean;
  } | null;
}

export const GOOGLE_SIGN_IN_SCOPES = 'openid email profile';

function normalizedEmail(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  const normalized = email.normalize('NFKC').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : undefined;
}

export function hasConfiguredOwnerEmail(ownerEmail: string | undefined): boolean {
  return normalizedEmail(ownerEmail) !== undefined;
}

export function isVerifiedGoogleOwner(profile: GoogleOwnerProfile | null | undefined, ownerEmail: string | undefined): boolean {
  const configuredOwner = normalizedEmail(ownerEmail);
  return Boolean(
    configuredOwner
    && profile?.email_verified === true
    && normalizedEmail(profile.email) === configuredOwner,
  );
}

export function isAllowedGoogleSignIn(providerId: string | undefined, profile: GoogleOwnerProfile | null | undefined, ownerEmail: string | undefined): boolean {
  return providerId === 'google' && isVerifiedGoogleOwner(profile, ownerEmail);
}

export function isOwnerSession(session: OwnerSession | null | undefined, ownerEmail: string | undefined): boolean {
  const configuredOwner = normalizedEmail(ownerEmail);
  return Boolean(
    configuredOwner
    && session?.user?.isOwner === true
    && normalizedEmail(session.user.email) === configuredOwner,
  );
}

export function canStartGoogleSignIn(input: {
  ownerEmail: string | undefined;
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  authSecret: string | undefined;
  trustHost: string | undefined;
}): boolean {
  return hasConfiguredOwnerEmail(input.ownerEmail)
    && Boolean(input.googleClientId?.trim())
    && Boolean(input.googleClientSecret?.trim())
    && Boolean(input.authSecret?.trim())
    && input.trustHost === 'true';
}
