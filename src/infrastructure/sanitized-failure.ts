export type SafeFailureKind =
  | 'timeout'
  | 'dns_tls'
  | 'rate_limited'
  | 'http_status'
  | 'rejected_redirect'
  | 'disallowed_host'
  | 'invalid_content'
  | 'network_error'
  | 'invalid_request'
  | 'missing_configuration';

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
  causeCode?: string;
  braveErrorCode?: string;
  requestId?: string;
}

export interface SafeResponseDiagnostics {
  responseReceived: true;
  statusCode?: number;
  contentTypeIsHtml?: boolean | null;
  bodyEmpty?: boolean | null;
  braveErrorCode?: string;
  requestId?: string;
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
    causeCode?: string;
    braveErrorCode?: string;
    requestId?: string;
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
    const causeCode = sanitizeTransportCode(options.causeCode);
    const braveErrorCode = sanitizeIdentifier(options.braveErrorCode);
    const requestId = sanitizeIdentifier(options.requestId);
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
      ...(causeCode ? { causeCode } : {}),
      ...(braveErrorCode ? { braveErrorCode } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }
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
  const kind = signals.some((signal) => signal === 'ABORTERROR' || signal === 'TIMEOUTERROR' ||
    signal === 'ETIMEDOUT' || signal === 'ESOCKETTIMEDOUT' || signal.startsWith('UND_ERR_') && signal.includes('TIMEOUT'))
    ? 'timeout'
    : signals.some((signal) => signal === 'ENOTFOUND' || signal === 'EAI_AGAIN' || signal === 'EAI_FAIL' || signal === 'ENODATA' ||
      signal.startsWith('ERR_TLS_') || signal.startsWith('ERR_SSL_') || signal.startsWith('CERT_') ||
      signal === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || signal === 'DEPTH_ZERO_SELF_SIGNED_CERT')
      ? 'dns_tls'
      : 'network_error';
  const safeError = new SanitizedIntegrationError(kind, {
    ...(resourceUrl ? { resourceUrl } : {}),
    ...(details.errorName ? { errorName: details.errorName } : {}),
    ...(details.causeCode ? { causeCode: details.causeCode } : {}),
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
  causeCode?: string;
  codes: string[];
} {
  if (depth > 5 || typeof value !== 'object' || value === null || seen.has(value)) return { codes: [] };
  seen.add(value);
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? sanitizeErrorName(record.name) : undefined;
  const code = typeof record.code === 'string' ? record.code.toUpperCase() : undefined;
  const safeCode = code ? sanitizeTransportCode(code) : undefined;
  const details = record.cause ? collectErrorDetails(record.cause, seen, depth + 1) : { codes: [] as string[] };
  const codes = [...(name ? [name.toUpperCase()] : []), ...(code ? [code] : []), ...details.codes];
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) codes.push(...collectErrorDetails(nested, seen, depth + 1).codes);
  }
  return {
    ...(name ? { errorName: name } : details.errorName ? { errorName: details.errorName } : {}),
    ...(safeCode ? { causeCode: safeCode } : details.causeCode ? { causeCode: details.causeCode } : {}),
    codes,
  };
}

function sanitizeErrorName(value: string | undefined): string | undefined {
  const allowed = new Set([
    'AbortError', 'ConnectTimeoutError', 'Error', 'FetchError', 'HeadersTimeoutError',
    'RequestAbortedError', 'SocketError', 'TimeoutError', 'TypeError',
  ]);
  return value && allowed.has(value) ? value : undefined;
}

function sanitizeTransportCode(value: string | undefined): string | undefined {
  if (!value || value.length > 64) return undefined;
  const code = value.toUpperCase();
  const allowed = new Set([
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED',
    'ECONNRESET', 'EHOSTUNREACH', 'ENODATA', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ESOCKETTIMEDOUT',
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
