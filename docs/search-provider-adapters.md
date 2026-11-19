# Search-provider adapter preparation

## Offline contract foundation

The shared `SearchProvider` contract keeps provider identity on normalized results and pages, uses `snippet` as the provider-facing text field, and retains `excerpt` for the current application contract. Page metadata is restricted to requested and returned counts, offset, pagination status, and validated country/targeting values. It must never include query text, credentials, headers, raw request URLs, or provider response bodies.

Provider adapters normalize transport data only. Application services remain responsible for exact-host checks, official-page evidence, identity and research-interest gates, deduplication, and owner review. A provider result is a discovery hint, not verified evidence.

## Adapter readiness

| Provider | State | Required before implementation |
|---|---|---|
| Brave | Existing adapter; contract extended and fixture-tested offline. No live request was made in this phase. | Confirm current official API documentation and provide credentials through the existing private local configuration. |
| Reddit | Placeholder only; no endpoint, authentication method, pricing, or response format is assumed. | Official API documentation, approved access method and credentials, rate-limit terms, and representative redacted response fixtures. |
| Quora | Placeholder only; no supported API or access method is assumed. | Official API documentation or confirmation of an approved integration, authentication details, rate-limit terms, and representative redacted response fixtures. |

Do not enable a provider until its documented request, authentication, limits, error behavior, and response format have been mapped to this contract and covered by offline fixtures. Keep secrets in ignored local configuration and out of tests, logs, fixtures, and Git.
