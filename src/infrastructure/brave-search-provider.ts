import './local-env.ts';
import { failureForHttpStatus, sanitizedIntegrationError, SanitizedIntegrationError } from './sanitized-failure.ts';

export interface SearchResult {
  title: string;
  url: string;
  excerpt: string;
}

export interface SearchProvider {
  search(query: string, options?: { countryCode?: string; count?: number }): Promise<SearchResult[]>;
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

  async search(query: string, options: { countryCode?: string; count?: number } = {}): Promise<SearchResult[]> {
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
    if (!response.ok) throw failureForHttpStatus(response.status);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('json')) throw new SanitizedIntegrationError('invalid_content');

    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new SanitizedIntegrationError('invalid_content');
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new SanitizedIntegrationError('invalid_content');
    }
    const web = (payload as BraveResponse).web;
    if (typeof web !== 'object' || web === null || !Array.isArray(web.results)) {
      throw new SanitizedIntegrationError('invalid_content');
    }
    return web.results.flatMap((result) => {
      if (typeof result.title !== 'string' || typeof result.url !== 'string' || typeof result.description !== 'string') return [];
      try {
        if (new URL(result.url).protocol !== 'https:') return [];
      } catch {
        return [];
      }
      return [{ title: result.title.trim(), url: result.url, excerpt: result.description.trim() }];
    });
  }
}
