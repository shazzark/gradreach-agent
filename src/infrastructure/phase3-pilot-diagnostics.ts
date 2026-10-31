import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const REJECTION_REASONS = new Set([
  'exact_host', 'title', 'excerpt', 'timeout', 'dns_tls', 'rate_limited', 'http_status',
  'rejected_redirect', 'disallowed_host', 'invalid_content', 'network_error', 'mongodb_server_error', 'invalid_request', 'missing_configuration', 'not_professor_profile',
]);

export type Phase3ResultDiagnostic = {
  country: string;
  hostname: string | null;
  outcome: 'rejected' | 'duplicate' | 'page_validated';
  rejectionReasons: string[];
};

/** Appends one content-free result record so later failures cannot replace earlier diagnostics. */
export async function appendPhase3ResultDiagnostic(
  diagnostic: Phase3ResultDiagnostic,
  path = 'outputs/phase3-result-diagnostics.jsonl',
): Promise<void> {
  const country = diagnostic.country.trim();
  const hostname = diagnostic.hostname?.toLowerCase() ?? null;
  if (!country || country.length > 80 || /[\u0000-\u001f\u007f]/.test(country)) {
    throw new TypeError('Invalid diagnostic country');
  }
  if (hostname !== null && !isHostname(hostname)) throw new TypeError('Invalid diagnostic hostname');
  if (!['rejected', 'duplicate', 'page_validated'].includes(diagnostic.outcome) ||
      diagnostic.rejectionReasons.some((reason) => !REJECTION_REASONS.has(reason))) {
    throw new TypeError('Invalid result diagnostic');
  }

  const record = {
    checkedAt: new Date().toISOString(),
    country,
    hostname,
    outcome: diagnostic.outcome,
    rejectionReasons: [...new Set(diagnostic.rejectionReasons)],
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split('.').length >= 2 && value.split('.').every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}
