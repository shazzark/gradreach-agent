import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const REJECTION_REASONS = new Set([
  'exact_host', 'title', 'excerpt', 'timeout', 'dns_tls', 'rate_limited', 'http_status',
  'rejected_redirect', 'disallowed_host', 'invalid_content', 'network_error', 'mongodb_server_error', 'invalid_request', 'missing_configuration', 'not_professor_profile',
]);

export type Phase3ResultDiagnostic = {
  country: string;
  hostname: string | null;
  outcome: 'rejected' | 'duplicate' | 'page_validated' | 'fetch_failed';
  rejectionReasons: string[];
  resourcePath?: string;
  statusCode?: number;
  errorName?: string;
  errorCode?: string;
  causeName?: string;
  causeCode?: string;
};

/** Appends one content-free result record so later failures cannot replace earlier diagnostics. */
export async function appendPhase3ResultDiagnostic(
  diagnostic: Phase3ResultDiagnostic,
  path = 'outputs/phase3-result-diagnostics.jsonl',
): Promise<void> {
  const country = diagnostic.country.trim();
  const hostname = diagnostic.hostname?.toLowerCase() ?? null;
  const resourcePath = sanitizePath(diagnostic.resourcePath);
  const statusCode = Number.isInteger(diagnostic.statusCode) && diagnostic.statusCode! >= 100 && diagnostic.statusCode! <= 599
    ? diagnostic.statusCode
    : undefined;
  const errorName = sanitizeErrorName(diagnostic.errorName);
  const errorCode = sanitizeTransportCode(diagnostic.errorCode);
  const causeName = sanitizeErrorName(diagnostic.causeName);
  const causeCode = sanitizeTransportCode(diagnostic.causeCode);
  if (!country || country.length > 80 || /[\u0000-\u001f\u007f]/.test(country)) {
    throw new TypeError('Invalid diagnostic country');
  }
  if (hostname !== null && !isHostname(hostname)) throw new TypeError('Invalid diagnostic hostname');
  if (!['rejected', 'duplicate', 'page_validated', 'fetch_failed'].includes(diagnostic.outcome) ||
      diagnostic.rejectionReasons.some((reason) => !REJECTION_REASONS.has(reason))) {
    throw new TypeError('Invalid result diagnostic');
  }

  const record = {
    checkedAt: new Date().toISOString(),
    country,
    hostname,
    outcome: diagnostic.outcome,
    rejectionReasons: [...new Set(diagnostic.rejectionReasons)],
    ...(resourcePath ? { resourcePath } : {}),
    ...(statusCode ? { statusCode } : {}),
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(causeName ? { causeName } : {}),
    ...(causeCode ? { causeCode } : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function sanitizePath(value: string | undefined): string | undefined {
  const pathOnly = value?.split(/[?#]/, 1)[0];
  return pathOnly && pathOnly.length <= 256 && pathOnly.startsWith('/') &&
    /^\/[A-Za-z0-9._~/-]*$/.test(pathOnly) && !pathOnly.split('/').includes('..')
    ? pathOnly
    : undefined;
}

function sanitizeErrorName(value: string | undefined): string | undefined {
  const allowed = new Set([
    'AbortError', 'ConnectTimeoutError', 'Error', 'FetchError', 'HeadersTimeoutError', 'MongoNetworkError',
    'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoTimeoutError', 'RequestAbortedError',
    'SocketError', 'TimeoutError', 'TypeError',
  ]);
  return value && allowed.has(value) ? value : undefined;
}

function sanitizeTransportCode(value: string | undefined): string | undefined {
  const allowed = new Set([
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED',
    'ECONNRESET', 'EHOSTUNREACH', 'EPIPE', 'ESOCKETTIMEDOUT', 'ETIMEOUT', 'ETIMEDOUT',
    'ENETUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  ]);
  const normalized = value?.toUpperCase();
  return normalized && allowed.has(normalized) ? normalized : undefined;
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split('.').length >= 2 && value.split('.').every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}
