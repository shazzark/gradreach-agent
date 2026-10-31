import { failureForHttpStatus, safeBraveResponseDiagnostics, sanitizedIntegrationError, SanitizedIntegrationError } from './sanitized-failure.ts';

export interface SearchResult {
  title: string;
  url: string;
  excerpt: string;
}

export interface RejectedSearchResultChecks {
  exactHost: boolean;
  title: boolean;
  excerpt: boolean;
  /** Host only; rejected URLs and their paths, queries, and credentials are never retained. */
  hostname: string | null;
}

export function diagnosticResultHostname(value: string): string | null {
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface SearchOptions {
  countryCode?: string;
  count?: number;
  onRejectedResult?: (checks: RejectedSearchResultChecks) => void | Promise<void>;
}

export interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

interface BraveResponse {
  web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
}

/** Brave Search adapter. Credentials stay in process configuration and are never included in errors. */
export class BraveSearchProvider implements SearchProvider {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey = process.env.SEARCH_PROVIDER_API_KEY, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.apiKey?.trim()) throw new SanitizedIntegrationError('missing_configuration');
    if (!query.trim() || query.length > 600) throw new SanitizedIntegrationError('invalid_request');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    const requestedCount = options.count ?? 10;
    if (!Number.isFinite(requestedCount)) throw new SanitizedIntegrationError('invalid_request');
    url.searchParams.set('count', String(Math.min(20, Math.max(1, Math.trunc(requestedCount)))));
    url.searchParams.set('safesearch', 'strict');
    if (options.countryCode) {
      if (!/^[A-Za-z]{2}$/.test(options.countryCode)) throw new SanitizedIntegrationError('invalid_request');
      url.searchParams.set('country', options.countryCode.toUpperCase());
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw sanitizedIntegrationError(error);
    }
    const responseDetails = safeBraveResponseDiagnostics(
      response,
      [query, this.apiKey].filter((value): value is string => Boolean(value)),
    );
    if (!response.ok) throw failureForHttpStatus(response.status, undefined, responseDetails);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('json')) {
      throw new SanitizedIntegrationError('invalid_content', responseDetails);
    }

    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new SanitizedIntegrationError('invalid_content', responseDetails);
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new SanitizedIntegrationError('invalid_content', responseDetails);
    }
    const web = (payload as BraveResponse).web;
    if (typeof web !== 'object' || web === null || !Array.isArray(web.results)) {
      throw new SanitizedIntegrationError('invalid_content', responseDetails);
    }
    const accepted: SearchResult[] = [];
    for (const result of web.results) {
      const title = typeof result.title === 'string' ? result.title.trim() : '';
      const resultUrl = typeof result.url === 'string' ? result.url : '';
      const excerpt = typeof result.description === 'string' ? result.description.trim() : '';
      let exactHost = true;
      try {
        exactHost = new URL(resultUrl).protocol !== 'https:';
      } catch {
        exactHost = true;
      }
      const checks = { exactHost, title: !title, excerpt: !excerpt, hostname: diagnosticResultHostname(resultUrl) };
      if (checks.exactHost || checks.title || checks.excerpt) {
        await options.onRejectedResult?.(checks);
        continue;
      }
      accepted.push({ title, url: resultUrl, excerpt });
    }
    return accepted;
  }
}
