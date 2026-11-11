import { isOwnerSession } from './owner-access.ts';
import { getToken } from 'next-auth/jwt';

export interface SocketOwnerToken {
  email?: unknown;
  ownerAllowed?: unknown;
}

export function isSocketOwnerToken(token: SocketOwnerToken | null, configuredOwnerEmail: string | undefined): boolean {
  return Boolean(token && token.ownerAllowed === true && isOwnerSession({
    user: { email: typeof token.email === 'string' ? token.email : null, isOwner: true },
  }, configuredOwnerEmail));
}

export function isTrustedSocketOrigin(origin: string | undefined, authUrl: string | undefined, host: string | undefined, forwardedProto: string | undefined, isProduction: boolean): boolean {
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const expectedOrigin = authUrl ? new URL(authUrl).origin
      : !isProduction && host ? `${forwardedProto === 'https' ? 'https' : 'http'}://${host}` : undefined;
    return Boolean(expectedOrigin && originUrl.origin === expectedOrigin &&
      (originUrl.protocol === 'https:' || (!isProduction && originUrl.protocol === 'http:')));
  } catch {
    return false;
  }
}

export async function isAuthorizedSocketHandshake(input: {
  headers: Record<string, string | string[] | undefined>;
  ownerEmail: string | undefined;
  secret: string | undefined;
  authUrl: string | undefined;
  isProduction: boolean;
}): Promise<boolean> {
  const origin = input.headers.origin;
  const forwardedProto = input.headers['x-forwarded-proto'];
  const host = input.headers.host;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  if (!input.secret || !input.ownerEmail || !isTrustedSocketOrigin(
    first(origin), input.authUrl, first(host), first(forwardedProto), input.isProduction,
  )) return false;

  const secureCookie = input.isProduction || input.authUrl?.startsWith('https://') === true;
  try {
    const requestHeaders = Object.fromEntries(Object.entries(input.headers).flatMap(([name, value]) => {
      if (typeof value === 'string') return [[name, value]];
      if (Array.isArray(value)) return [[name, value.join(', ')]];
      return [];
    }));
    const token = await getToken({ req: { headers: requestHeaders }, secret: input.secret, secureCookie });
    return isSocketOwnerToken(token, input.ownerEmail);
  } catch {
    return false;
  }
}
