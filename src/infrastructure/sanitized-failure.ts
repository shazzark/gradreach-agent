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
  statusCode?: number;
  resourceUrl?: string;
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

  constructor(kind: SafeFailureKind, options: { statusCode?: number; resourceUrl?: string } = {}) {
    const requestedStatusCode = options.statusCode;
    const statusCode = typeof requestedStatusCode === 'number' && Number.isInteger(requestedStatusCode) &&
      requestedStatusCode >= 100 && requestedStatusCode <= 599
      ? requestedStatusCode
      : undefined;
    const resourceUrl = sanitizeResourceUrl(options.resourceUrl);
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
      ...(statusCode ? { statusCode } : {}),
      ...(resourceUrl ? { resourceUrl } : {}),
    };
  }
}

/** Produces a stable failure record without copying raw error messages, causes, headers, or response bodies. */
export function safeFailureRecord(error: unknown, resourceUrl?: string): SafeFailureRecord {
  if (error instanceof SanitizedIntegrationError) {
    const safeUrl = sanitizeResourceUrl(resourceUrl);
    return safeUrl && !error.failure.resourceUrl ? { ...error.failure, resourceUrl: safeUrl } : error.failure;
  }

  const signals = collectSignals(error);
  const kind = signals.some((signal) => signal === 'ABORTERROR' || signal === 'TIMEOUTERROR' ||
    signal === 'ETIMEDOUT' || signal === 'ESOCKETTIMEDOUT' || signal.startsWith('UND_ERR_') && signal.includes('TIMEOUT'))
    ? 'timeout'
    : signals.some((signal) => signal === 'ENOTFOUND' || signal === 'EAI_AGAIN' || signal === 'EAI_FAIL' || signal === 'ENODATA' ||
      signal.startsWith('ERR_TLS_') || signal.startsWith('ERR_SSL_') || signal.startsWith('CERT_') ||
      signal === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || signal === 'DEPTH_ZERO_SELF_SIGNED_CERT')
      ? 'dns_tls'
      : 'network_error';
  const safeError = new SanitizedIntegrationError(kind, resourceUrl ? { resourceUrl } : {});
  return safeError.failure;
}

/** Converts an unknown provider/fetch error into an error safe to persist or show. */
export function sanitizedIntegrationError(error: unknown, resourceUrl?: string): SanitizedIntegrationError {
  if (error instanceof SanitizedIntegrationError && (!resourceUrl || error.failure.resourceUrl)) return error;
  const record = safeFailureRecord(error, resourceUrl);
  return new SanitizedIntegrationError(record.kind, record);
}

export function failureForHttpStatus(statusCode: number, resourceUrl?: string): SanitizedIntegrationError {
  return new SanitizedIntegrationError(statusCode === 429 ? 'rate_limited' : 'http_status', {
    statusCode,
    ...(resourceUrl ? { resourceUrl } : {}),
  });
}

function collectSignals(value: unknown, seen = new Set<object>(), depth = 0): string[] {
  if (depth > 5 || typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  const record = value as Record<string, unknown>;
  const signals = [record.name, record.code].filter((signal): signal is string => typeof signal === 'string').map((signal) => signal.toUpperCase());
  if (record.cause) signals.push(...collectSignals(record.cause, seen, depth + 1));
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) signals.push(...collectSignals(nested, seen, depth + 1));
  }
  return signals;
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
