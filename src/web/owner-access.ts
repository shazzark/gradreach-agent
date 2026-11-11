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
export const DEFAULT_WORKSPACE_PATH = '/workspace';

export function isPublicWebsitePath(pathname: string): boolean {
  return pathname === '/' || pathname === '/sign-in' || pathname === '/icon.svg' || pathname === '/apple-icon' || pathname === '/manifest.webmanifest' || pathname === '/api/auth' || pathname.startsWith('/api/auth/');
}

/** Converts Auth.js callback URLs to local paths so sign-in cannot become an open redirect. */
export function safeWorkspaceReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\\')) return DEFAULT_WORKSPACE_PATH;
  const candidate = value.trim();
  if (!candidate || candidate.startsWith('//')) return DEFAULT_WORKSPACE_PATH;

  try {
    const base = 'https://gradreach.invalid';
    const url = new URL(candidate, base);
    const isRelative = candidate.startsWith('/');
    if ((!isRelative && url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return DEFAULT_WORKSPACE_PATH;
    }
    const path = `${url.pathname}${url.search}`;
    if (url.pathname === '/sign-in' || url.pathname.startsWith('/sign-in/') || url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return DEFAULT_WORKSPACE_PATH;
    }
    return path.startsWith('/') && !path.startsWith('//') ? path : DEFAULT_WORKSPACE_PATH;
  } catch {
    return DEFAULT_WORKSPACE_PATH;
  }
}

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
