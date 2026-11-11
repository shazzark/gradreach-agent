export type SafeFailureKind =
  | 'timeout'
  | 'dns_tls'
  | 'rate_limited'
  | 'http_status'
  | 'rejected_redirect'
  | 'disallowed_host'
  | 'invalid_content'
  | 'network_error'
  | 'mongodb_server_error'
  | 'invalid_request'
  | 'missing_configuration';

export type AtlasErrorCategory =
  | 'authentication_failed'
  | 'authorization_denied'
  | 'network_access_denied'
  | 'other_atlas_error';

export interface SafeFailureRecord {
  kind: SafeFailureKind;
  message: string;
  responseReceived: boolean;
  statusCode?: number;
  resourceUrl?: string;
  resourceHost?: string;
  resourcePath?: string;
  contentTypeIsHtml?: boolean | null;
  bodyEmpty?: boolean | null;
  errorName?: string;
  codeName?: string;
  errorCode?: string;
  atlasCategory?: AtlasErrorCategory;
  causeName?: string;
  causeCode?: string;
  syscall?: string;
  serverStates?: string[];
  braveErrorCode?: string;
  braveErrorId?: string;
  requestId?: string;
  redirectDestinationHost?: string;
  redirectDestinationPath?: string;
}

export interface SafeResponseDiagnostics {
  responseReceived: true;
  statusCode?: number;
  contentTypeIsHtml?: boolean | null;
  bodyEmpty?: boolean | null;
  braveErrorCode?: string;
  braveErrorId?: string;
  requestId?: string;
  redirectDestinationHost?: string;
  redirectDestinationPath?: string;
}

const FAILURE_MESSAGES: Record<SafeFailureKind, string> = {
  timeout: 'Request timed out.',
  dns_tls: 'DNS or TLS connection failed.',
  rate_limited: 'Remote service rate limited the request (HTTP 429).',
  http_status: 'Remote service returned an unsuccessful HTTP status.',
  rejected_redirect: 'Official page redirect was rejected.',
  disallowed_host: 'URL host is not in the exact official host allowlist.',
  invalid_content: 'Response content was invalid for the requested operation.',
  network_error: 'Network request failed.',
  mongodb_server_error: 'MongoDB server returned an error.',
  invalid_request: 'Request parameters are invalid.',
  missing_configuration: 'SEARCH_PROVIDER_API_KEY must be configured to use web discovery.',
};

export class SanitizedIntegrationError extends Error {
  readonly failure: SafeFailureRecord;

  constructor(kind: SafeFailureKind, options: {
    statusCode?: number;
    resourceUrl?: string;
    responseReceived?: boolean;
    errorName?: string;
    codeName?: string;
    errorCode?: string;
    atlasCategory?: AtlasErrorCategory;
    causeName?: string;
    causeCode?: string;
    syscall?: string;
    serverStates?: string[];
    braveErrorCode?: string;
    braveErrorId?: string;
    requestId?: string;
    redirectDestinationHost?: string;
    redirectDestinationPath?: string;
    contentTypeIsHtml?: boolean | null;
    bodyEmpty?: boolean | null;
  } = {}) {
    const requestedStatusCode = options.statusCode;
    const statusCode = typeof requestedStatusCode === 'number' && Number.isInteger(requestedStatusCode) &&
      requestedStatusCode >= 100 && requestedStatusCode <= 599
      ? requestedStatusCode
      : undefined;
    const resourceUrl = sanitizeResourceUrl(options.resourceUrl);
    const resourceLocation = resourceParts(resourceUrl);
    const errorName = sanitizeErrorName(options.errorName);
    const codeName = sanitizeMongoCodeName(options.codeName);
    const errorCode = sanitizeDiagnosticCode(options.errorCode);
    const atlasCategory = sanitizeAtlasErrorCategory(options.atlasCategory);
    const causeName = sanitizeErrorName(options.causeName);
    const causeCode = sanitizeTransportCode(options.causeCode);
    const syscall = sanitizeSyscall(options.syscall);
    const serverStates = sanitizeServerStates(options.serverStates);
    const braveErrorCode = sanitizeIdentifier(options.braveErrorCode);
    const braveErrorId = sanitizeIdentifier(options.braveErrorId);
    const requestId = sanitizeIdentifier(options.requestId);
    const redirectDestination = sanitizeRedirectDestination(options.redirectDestinationHost, options.redirectDestinationPath);
    const message = kind === 'http_status' && statusCode
      ? `Remote service returned HTTP ${statusCode}.`
      : kind === 'rejected_redirect' && statusCode
        ? `Official page redirect was rejected (HTTP ${statusCode}).`
        : FAILURE_MESSAGES[kind];
    super(message);
    this.name = 'SanitizedIntegrationError';
    this.failure = {
      kind,
      message,
      responseReceived: options.responseReceived === true,
      ...(statusCode ? { statusCode } : {}),
      ...(resourceUrl ? { resourceUrl } : {}),
      ...(resourceLocation ? {
        resourceHost: resourceLocation.hostname,
        resourcePath: resourceLocation.path,
        contentTypeIsHtml: options.contentTypeIsHtml ?? null,
        bodyEmpty: options.bodyEmpty ?? null,
      } : {}),
      ...(errorName ? { errorName } : {}),
      ...(codeName ? { codeName } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(atlasCategory ? { atlasCategory } : {}),
      ...(causeName ? { causeName } : {}),
      ...(causeCode ? { causeCode } : {}),
      ...(syscall ? { syscall } : {}),
      ...(serverStates ? { serverStates } : {}),
      ...(braveErrorCode ? { braveErrorCode } : {}),
      ...(braveErrorId ? { braveErrorId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(redirectDestination ? { redirectDestinationHost: redirectDestination.host, redirectDestinationPath: redirectDestination.path } : {}),
    };
  }
}

function sanitizeRedirectDestination(host: string | undefined, path: string | undefined): { host: string; path: string } | undefined {
  if (!host || !path || host.length > 253 || !path.startsWith('/') || path.length > 256 ||
      !/^[a-z0-9.-]+$/i.test(host) || !/^\/[A-Za-z0-9._~/-]*$/.test(path) || path.split('/').includes('..')) return undefined;
  return { host: host.toLowerCase(), path };
}

/** Produces a stable failure record without copying raw error messages, causes, headers, or response bodies. */
export function safeFailureRecord(error: unknown, resourceUrl?: string): SafeFailureRecord {
  if (error instanceof SanitizedIntegrationError) {
    const safeUrl = sanitizeResourceUrl(resourceUrl);
    return safeUrl && !error.failure.resourceUrl
      ? new SanitizedIntegrationError(error.failure.kind, { ...error.failure, resourceUrl: safeUrl }).failure
      : error.failure;
  }

  const details = collectErrorDetails(error);
  const signals = details.codes;
  const atlasCategory = details.errorName === 'MongoServerError' && details.codeName === 'AtlasError' && details.errorCode === '8000'
    ? classifyAtlasErrorMessage(error)
    : undefined;
  const kind = details.errorName === 'MongoServerError' || details.codeName
    ? 'mongodb_server_error'
    : signals.some((signal) => signal === 'ABORTERROR' || signal === 'TIMEOUTERROR' ||
    signal === 'ETIMEOUT' || signal === 'ETIMEDOUT' || signal === 'ESOCKETTIMEDOUT' ||
    signal.startsWith('UND_ERR_') && signal.includes('TIMEOUT'))
    ? 'timeout'
    : signals.some((signal) => signal === 'ENOTFOUND' || signal === 'EAI_AGAIN' || signal === 'EAI_FAIL' || signal === 'ENODATA' ||
      signal.startsWith('ERR_TLS_') || signal.startsWith('ERR_SSL_') || signal.startsWith('CERT_') ||
      signal === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || signal === 'DEPTH_ZERO_SELF_SIGNED_CERT')
      ? 'dns_tls'
      : 'network_error';
  const safeError = new SanitizedIntegrationError(kind, {
    ...(resourceUrl ? { resourceUrl } : {}),
    ...(details.errorName ? { errorName: details.errorName } : {}),
    ...(details.codeName ? { codeName: details.codeName } : {}),
    ...(details.errorCode ? { errorCode: details.errorCode } : {}),
    ...(atlasCategory ? { atlasCategory } : {}),
    ...(details.causeName ? { causeName: details.causeName } : {}),
    ...(details.causeCode ? { causeCode: details.causeCode } : {}),
    ...(details.syscall ? { syscall: details.syscall } : {}),
    ...(details.serverStates ? { serverStates: details.serverStates } : {}),
  });
  return safeError.failure;
}

/** Converts an unknown provider/fetch error into an error safe to persist or show. */
export function sanitizedIntegrationError(
  error: unknown,
  resourceUrl?: string,
  responseDetails?: SafeResponseDiagnostics,
): SanitizedIntegrationError {
  if (error instanceof SanitizedIntegrationError && (!resourceUrl || error.failure.resourceUrl) && !responseDetails) return error;
  const record = safeFailureRecord(error, resourceUrl);
  return new SanitizedIntegrationError(record.kind, { ...record, ...responseDetails });
}

export function failureForHttpStatus(
  statusCode: number,
  resourceUrl?: string,
  responseDetails: SafeResponseDiagnostics = { responseReceived: true },
): SanitizedIntegrationError {
  return new SanitizedIntegrationError(statusCode === 429 ? 'rate_limited' : 'http_status', {
    statusCode,
    ...responseDetails,
    ...(resourceUrl ? { resourceUrl } : {}),
  });
}

function collectErrorDetails(value: unknown, seen = new Set<object>(), depth = 0): {
  errorName?: string;
  codeName?: string;
  errorCode?: string;
  causeName?: string;
  causeCode?: string;
  syscall?: string;
  serverStates?: string[];
  codes: string[];
} {
  if (depth > 5 || typeof value !== 'object' || value === null || seen.has(value)) return { codes: [] };
  seen.add(value);
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? sanitizeErrorName(record.name) : undefined;
  const code = typeof record.code === 'string'
    ? record.code.toUpperCase()
    : typeof record.code === 'number' && Number.isInteger(record.code) && record.code >= 0 && record.code <= 999999
      ? String(record.code)
      : undefined;
  const errorCode = code ? sanitizeDiagnosticCode(code) : undefined;
  const codeName = typeof record.codeName === 'string' ? sanitizeMongoCodeName(record.codeName) : undefined;
  const cause = typeof record.cause === 'object' && record.cause !== null
    ? collectErrorDetails(record.cause, seen, depth + 1)
    : { codes: [] as string[] };
  const serverFailure = collectServerFailureDetails(record.reason, seen, depth + 1);
  const syscall = typeof record.syscall === 'string' ? sanitizeSyscall(record.syscall) : undefined;
  const serverStates = collectServerStates(record.reason);
  const codes = [...(name ? [name.toUpperCase()] : []), ...(code ? [code] : []), ...cause.codes, ...serverFailure.codes];
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) codes.push(...collectErrorDetails(nested, seen, depth + 1).codes);
  }
  return {
    ...(name ? { errorName: name } : {}),
    ...(codeName ? { codeName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...((cause.errorName ?? cause.causeName ?? serverFailure.errorName ?? serverFailure.causeName)
      ? { causeName: cause.errorName ?? cause.causeName ?? serverFailure.errorName ?? serverFailure.causeName }
      : {}),
    ...((cause.errorCode ?? cause.causeCode ?? serverFailure.errorCode ?? serverFailure.causeCode)
      ? { causeCode: cause.errorCode ?? cause.causeCode ?? serverFailure.errorCode ?? serverFailure.causeCode }
      : {}),
    ...((syscall ?? cause.syscall ?? serverFailure.syscall)
      ? { syscall: syscall ?? cause.syscall ?? serverFailure.syscall }
      : {}),
    ...(serverStates ? { serverStates } : {}),
    codes,
  };
}

function sanitizeErrorName(value: string | undefined): string | undefined {
  const allowed = new Set([
    'AbortError', 'ConnectTimeoutError', 'Error', 'FetchError', 'HeadersTimeoutError', 'MongoServerError',
    'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoTimeoutError',
    'RequestAbortedError', 'SocketError', 'TimeoutError', 'TypeError',
  ]);
  return value && allowed.has(value) ? value : undefined;
}

function sanitizeMongoCodeName(value: string | undefined): string | undefined {
  const allowed = new Set([
    'AtlasError', 'AuthenticationFailed', 'BadValue', 'CommandNotFound', 'DuplicateKey',
    'ExceededTimeLimit', 'HostUnreachable', 'IllegalOperation', 'IndexNotFound', 'InvalidOptions',
    'NetworkTimeout', 'NamespaceNotFound', 'NotPrimary', 'OperationFailed', 'PrimarySteppedDown',
    'ShutdownInProgress', 'Unauthorized',
  ]);
  return value && allowed.has(value) ? value : undefined;
}

function sanitizeAtlasErrorCategory(value: AtlasErrorCategory | undefined): AtlasErrorCategory | undefined {
  return value && ['authentication_failed', 'authorization_denied', 'network_access_denied', 'other_atlas_error'].includes(value)
    ? value
    : undefined;
}

function classifyAtlasErrorMessage(error: unknown): AtlasErrorCategory {
  if (typeof error !== 'object' || error === null) return 'other_atlas_error';
  const message = (error as Record<string, unknown>).message;
  if (typeof message !== 'string') return 'other_atlas_error';
  const normalized = message.toLowerCase();
  if (/authentication failed|authenticationfailure|bad auth|sasl authentication/.test(normalized)) {
    return 'authentication_failed';
  }
  if (/ip(?:v4|v6)? address.{0,120}(?:not allowed|not in|not on|missing from|has not been added)/.test(normalized) ||
      /ip access list|network access denied/.test(normalized)) {
    return 'network_access_denied';
  }
  if (/not authorized|unauthorized|authorization denied|not permitted|insufficient privilege/.test(normalized)) {
    return 'authorization_denied';
  }
  return 'other_atlas_error';
}

function sanitizeDiagnosticCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const code = value.toUpperCase();
  const mongoCodes = new Set([
    'MONGOSERVERSELECTIONERROR', 'MONGONETWORKERROR', 'MONGONETWORKTIMEOUTERROR', 'MONGOTIMEOUTERROR',
  ]);
  return mongoCodes.has(code) || /^\d{1,6}$/.test(code) ? code : sanitizeTransportCode(code);
}

function sanitizeSyscall(value: string | undefined): string | undefined {
  const allowed = new Set(['connect', 'getaddrinfo', 'querySrv', 'queryTxt', 'read', 'write']);
  return value && allowed.has(value) ? value : undefined;
}

function sanitizeServerStates(value: unknown): string[] | undefined {
  const allowed = new Set([
    'Unknown', 'Standalone', 'Mongos', 'RSPrimary', 'RSSecondary', 'RSArbiter', 'RSOther', 'RSGhost', 'LoadBalancer',
  ]);
  if (!Array.isArray(value)) return undefined;
  const states = [...new Set(value.filter((state): state is string => typeof state === 'string' && allowed.has(state)))].sort();
  return states.length ? states : undefined;
}

function collectServerStates(reason: unknown): string[] | undefined {
  if (typeof reason !== 'object' || reason === null) return undefined;
  const servers = (reason as Record<string, unknown>).servers;
  const descriptions = servers instanceof Map ? [...servers.values()] : [];
  const states = descriptions.flatMap((description) => {
    if (typeof description !== 'object' || description === null) return [];
    const type = (description as Record<string, unknown>).type;
    return typeof type === 'string' ? [type] : [];
  });
  return sanitizeServerStates(states);
}

function collectServerFailureDetails(reason: unknown, seen: Set<object>, depth: number): {
  errorName?: string;
  errorCode?: string;
  causeName?: string;
  causeCode?: string;
  syscall?: string;
  codes: string[];
} {
  if (typeof reason !== 'object' || reason === null) return { codes: [] };
  const servers = (reason as Record<string, unknown>).servers;
  const descriptions = servers instanceof Map ? [...servers.values()] : [];
  const failures = descriptions.flatMap((description) => {
    if (typeof description !== 'object' || description === null) return [];
    const error = (description as Record<string, unknown>).error;
    return typeof error === 'object' && error !== null
      ? [collectErrorDetails(error, seen, depth)]
      : [];
  });
  const first = <T extends keyof Omit<ReturnType<typeof collectErrorDetails>, 'codes'>>(key: T) =>
    failures.find((failure) => failure[key] !== undefined)?.[key];
  const errorName = first('errorName');
  const errorCode = first('errorCode');
  const causeName = first('causeName');
  const causeCode = first('causeCode');
  const syscall = first('syscall');
  return {
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(causeName ? { causeName } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(syscall ? { syscall } : {}),
    codes: failures.flatMap((failure) => failure.codes),
  };
}

function sanitizeTransportCode(value: string | undefined): string | undefined {
  if (!value || value.length > 64) return undefined;
  const code = value.toUpperCase();
  const allowed = new Set([
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED',
    'ECONNRESET', 'EHOSTUNREACH', 'ENODATA', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ESOCKETTIMEDOUT', 'ETIMEOUT',
    'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]);
  return allowed.has(code) || /^(ERR_TLS|ERR_SSL)_[A-Z0-9_]+$/.test(code) || /^CERT_[A-Z0-9_]+$/.test(code)
    ? code
    : undefined;
}

function sanitizeIdentifier(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

export function safeBraveResponseDiagnostics(response: Response, sensitiveValues: string[] = []): SafeResponseDiagnostics {
  const safeHeader = (names: string[]) => {
    for (const name of names) {
      const value = response.headers.get(name)?.trim();
      const safe = sanitizeIdentifier(value);
      if (!safe) continue;
      const lower = safe.toLowerCase();
      if (sensitiveValues.some((sensitive) => {
        const normalized = sensitive.trim().toLowerCase();
        return normalized && (lower.includes(normalized) || normalized.includes(lower));
      })) continue;
      return safe;
    }
    return undefined;
  };
  const braveErrorCode = safeHeader(['x-brave-error-code']);
  const requestId = safeHeader(['x-brave-request-id', 'x-request-id']);
  return {
    responseReceived: true,
    ...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? { statusCode: response.status }
      : {}),
    ...(braveErrorCode ? { braveErrorCode } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/** Extracts only Brave's documented error code and occurrence ID; response details are never retained. */
export async function safeBraveErrorResponseDiagnostics(response: Response, sensitiveValues: string[] = []): Promise<SafeResponseDiagnostics> {
  const details = safeBraveResponseDiagnostics(response, sensitiveValues);
  try {
    const reader = response.clone().body?.getReader();
    if (!reader) return details;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        return details;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return details;
    const error = (payload as Record<string, unknown>).error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return details;
    const record = error as Record<string, unknown>;
    const code = typeof record.code === 'string' ? sanitizeIdentifier(record.code) : undefined;
    const id = typeof record.id === 'string' ? sanitizeIdentifier(record.id) : undefined;
    const isSensitive = (value: string | undefined) => Boolean(value && sensitiveValues.some((sensitive) => {
      const normalized = sensitive.trim().toLowerCase();
      return normalized && (value.toLowerCase().includes(normalized) || normalized.includes(value.toLowerCase()));
    }));
    return {
      ...details,
      ...(code && !isSensitive(code) ? { braveErrorCode: code } : {}),
      ...(id && !isSensitive(id) ? { braveErrorId: id } : {}),
    };
  } catch { return details; }
}

function sanitizeResourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function resourceParts(value: string | undefined): { hostname: string; path: string } | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return { hostname: url.hostname.toLowerCase(), path: url.pathname };
  } catch {
    return undefined;
  }
}
