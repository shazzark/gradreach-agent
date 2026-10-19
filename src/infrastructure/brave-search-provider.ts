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
    if (!this.apiKey?.trim()) throw new Error('SEARCH_PROVIDER_API_KEY must be configured to use web discovery');
    if (!query.trim() || query.length > 600) throw new Error('Search query must contain 1 to 600 characters');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    const requestedCount = options.count ?? 10;
    if (!Number.isFinite(requestedCount)) throw new Error('count must be a finite number');
    url.searchParams.set('count', String(Math.min(20, Math.max(1, Math.trunc(requestedCount)))));
    url.searchParams.set('safesearch', 'strict');
    if (options.countryCode) {
      if (!/^[A-Za-z]{2}$/.test(options.countryCode)) throw new Error('countryCode must be an ISO alpha-2 code');
      url.searchParams.set('country', options.countryCode.toUpperCase());
    }
    const response = await this.fetchImpl(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Brave Search request failed with HTTP ${response.status}`);
    const payload = await response.json() as BraveResponse;
    return (payload.web?.results ?? []).flatMap((result) => {
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
