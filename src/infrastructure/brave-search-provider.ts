import { failureForHttpStatus, safeBraveErrorResponseDiagnostics, safeBraveResponseDiagnostics, sanitizedIntegrationError, SanitizedIntegrationError } from './sanitized-failure.ts';

export interface SearchResult {
  /** Stable adapter identifier; never contains request credentials or query text. */
  provider?: string;
  title: string;
  url: string;
  /** Normalized provider snippet. `excerpt` remains the application-compatible field. */
  snippet?: string;
  excerpt: string;
  /** One-based position in the provider response; never persisted with candidate content. */
  resultNumber?: number;
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
  region?: string;
  targetingMode?: 'api_country' | 'query_and_host';
  count?: number;
  /** Zero-based Brave result page, from 0 through 9. */
  offset?: number;
  onRejectedResult?: (checks: RejectedSearchResultChecks, resultNumber?: number) => void | Promise<void>;
}

export interface SearchPage {
  provider?: string;
  results: SearchResult[];
  moreResultsAvailable: boolean;
  paginationKnown: boolean;
  /** Excludes query text, credentials, headers, and request URLs. */
  requestMetadata?: SafeSearchRequestMetadata;
}

export interface SafeSearchRequestMetadata {
  requestedCount: number;
  providerResultCount: number;
  acceptedResultCount: number;
  offset: number;
  paginationKnown: boolean;
  moreResultsAvailable: boolean;
  countryCode?: string;
  targetingMode?: SearchOptions['targetingMode'];
}

// These country values are explicitly surfaced by Brave's API reference: visible enum entries,
// the documented DE request example, and the US default. Other codes use query-and-host targeting.
export const VERIFIED_BRAVE_COUNTRY_CODES = ['AR', 'AU', 'AT', 'DE', 'US'] as const;

export function isVerifiedBraveCountryCode(value: string | undefined): value is typeof VERIFIED_BRAVE_COUNTRY_CODES[number] {
  return Boolean(value && (VERIFIED_BRAVE_COUNTRY_CODES as readonly string[]).includes(value.toUpperCase()));
}

export interface SearchProvider {
  readonly providerName?: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  searchPage?(query: string, options?: SearchOptions): Promise<SearchPage>;
}

interface BraveResponse {
  web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
  query?: { more_results_available?: unknown };
}

/** Brave Search adapter. Credentials stay in process configuration and are never included in errors. */
export class BraveSearchProvider implements SearchProvider {
  readonly providerName = 'brave';
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey = process.env.SEARCH_PROVIDER_API_KEY, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    return (await this.searchPage(query, options)).results;
  }

  async searchPage(query: string, options: SearchOptions = {}): Promise<SearchPage> {
    if (!this.apiKey?.trim()) throw new SanitizedIntegrationError('missing_configuration');
    if (!query.trim() || query.length > 600) throw new SanitizedIntegrationError('invalid_request');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    const requestedCount = options.count ?? 10;
    if (!Number.isFinite(requestedCount)) throw new SanitizedIntegrationError('invalid_request');
    const boundedCount = Math.min(20, Math.max(1, Math.trunc(requestedCount)));
    url.searchParams.set('count', String(boundedCount));
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 9) throw new SanitizedIntegrationError('invalid_request');
    url.searchParams.set('offset', String(offset));
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
    let responseDetails = safeBraveResponseDiagnostics(
      response,
      [query, this.apiKey].filter((value): value is string => Boolean(value)),
    );
    if (!response.ok) {
      responseDetails = await safeBraveErrorResponseDiagnostics(response, [query, this.apiKey].filter((value): value is string => Boolean(value)));
      throw failureForHttpStatus(response.status, undefined, responseDetails);
    }
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
    const bravePayload = payload as BraveResponse;
    const web = bravePayload.web;
    if (typeof web !== 'object' || web === null || !Array.isArray(web.results)) {
      throw new SanitizedIntegrationError('invalid_content', responseDetails);
    }
    if (web.results.some((result) => typeof result !== 'object' || result === null || Array.isArray(result))) {
      throw new SanitizedIntegrationError('invalid_content', responseDetails);
    }
    const accepted: SearchResult[] = [];
    for (const [index, result] of web.results.entries()) {
      if (accepted.length >= boundedCount) break;
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
        await options.onRejectedResult?.(checks, index + 1);
        continue;
      }
      accepted.push({ provider: this.providerName, title, url: resultUrl, snippet: excerpt, excerpt, resultNumber: index + 1 });
    }
    const moreResultsAvailable = bravePayload.query?.more_results_available;
    const paginationKnown = typeof moreResultsAvailable === 'boolean';
    return {
      provider: this.providerName,
      results: accepted,
      moreResultsAvailable: moreResultsAvailable === true,
      paginationKnown,
      requestMetadata: {
        requestedCount: boundedCount,
        providerResultCount: web.results.length,
        acceptedResultCount: accepted.length,
        offset,
        paginationKnown,
        moreResultsAvailable: moreResultsAvailable === true,
        ...(options.countryCode ? { countryCode: options.countryCode.toUpperCase() } : {}),
        ...(options.targetingMode ? { targetingMode: options.targetingMode } : {}),
      },
    };
  }
}
