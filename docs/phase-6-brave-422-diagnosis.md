# Phase 6 — Brave Search HTTP 422 diagnosis

Checked 2026-11-20. Scope: audit finding A-03, remediation step R6
(`AUDIT.md:506`). No dependency, npm script, or `DISCOVERY_LIMITS` value was
changed.

## Symptom

The documented live discovery attempts converted a large share of search
requests into `HTTP 422` responses and saved no fully qualified lead:
`README.md:9` records 26 requests with 15 failures, and
`outputs/phase3-result-diagnostics.jsonl` (written 2026-11-09) holds 19
`stage=brave_search, outcome=search_failed, statusCode=422` records.

Every recorded 422 was in the Europe continuation batch and belonged to one of
these regions: Bosnia and Herzegovina, Bulgaria, Croatia, Czechia, Estonia,
Hungary, Iceland, Ireland, Latvia, Liechtenstein, Lithuania, Luxembourg, Malta,
Moldova, Montenegro, Serbia, Slovakia, Slovenia, Ukraine.

Requests for Canada, Australia, Germany, Japan, and the United States in the
same period returned `200`.

## Method

1. Read the request the provider builds
   (`src/infrastructure/brave-search-provider.ts`): `GET
   https://api.search.brave.com/res/v1/web/search` with `q`, `count`, `offset`,
   `safesearch=strict`, an optional `country`, and the
   `X-Subscription-Token` header.
2. Inspected the recorded diagnostics. The failing records retained only
   `stage`, `country`, `outcome`, `rejectionReasons`, and `statusCode`; the
   then-current recorder captured no Brave error code, so the response body had
   to be obtained again.
3. Ran a bounded live probe with the project's own provider class (four
   requests) plus a parameter matrix against the same endpoint and key (eight
   requests). Only sanitized fields were printed: HTTP status, Brave `code`,
   Brave `detail`, and the enum from `error.meta`. The API key and query text
   were redacted; no response body and no credential was stored.

## Evidence

### First probe: current request shapes against a real allowlisted host

| Request | Status |
|---|---|
| `site:` + `(faculty directory OR professor profile) research … MSc Slovenia` | 200 (2 results) |
| quoted alternatives `("faculty directory" OR "faculty members" OR "academic staff")` | 200 (3 results) |
| eight interests joined with `OR` (246 characters) | 200 (3 results) |
| repeat of the first request | 200 (2 results) |

The provider's query syntax, headers, `count`, `offset`, and `safesearch` values
were therefore accepted.

### Second probe: parameter isolation

| Query | Parameters | Status | Brave error |
|---|---|---|---|
| valid app query | `country=CA`, `count=3`, `offset=0` | 200 | — |
| valid app query | `country=SI`, `count=3`, `offset=0` | **422** | `code=VALIDATION` |
| valid app query | `country=BA`, `count=3`, `offset=0` | **422** | `code=VALIDATION` |
| valid app query | `country=CZ`, `count=3`, `offset=0` | **422** | `code=VALIDATION` |
| 520-character query | no `country` | 200 | — |
| 600-character query | no `country` | 200 | — |
| valid app query | `count=20`, `offset=9` | 200 | — |
| valid app query | `count=3`, `offset=9` | 200 | — |

The 422 body was:

```json
{ "type": "ErrorResponse",
  "error": { "id": "…", "status": 422, "code": "VALIDATION",
             "detail": "Unable to validate request parameter(s)",
             "meta": { "errors": [ { "type": "enum", "loc": ["query", "country"],
               "msg": "Input should be 'AR', 'AU', 'AT', 'BE', 'BR', 'CA', 'CL', 'DK', 'FI', 'FR', 'DE', 'GR', 'HK', 'IN', 'ID', 'IT', 'JP', 'KR', 'MY', 'MX', 'NL', 'NZ', 'NO', 'CN', 'PL', 'PT', 'PH', 'RU', 'SA', 'ZA', 'ES', 'SE', 'CH', 'TW', 'TR', 'GB', 'US' or 'ALL'",
               "input": "SI" } ] } } }
```

## Root cause

Brave validates the `country` parameter against a fixed enum and rejects every
other value with `HTTP 422` and `code: VALIDATION`. The failing regions are
exactly the configured countries whose ISO 3166-1 alpha-2 code is absent from
that enum (`SI`, `BA`, `CZ`, `EE`, `HR`, `HU`, `IS`, `IE`, `LV`, `LI`, `LT`,
`LU`, `MT`, `MD`, `ME`, `RS`, `SK`, `UA`, `BG`), while supported codes such as
`CA`, `AU`, `DE`, `JP`, and `US` succeeded. The recorded run does not retain
request parameters, so this is established by correlation plus direct
reproduction, not by replaying the original bytes.

The 422 is a request-validation failure: repeating the identical request cannot
succeed. It is not a rate limit (Brave answers 429 for those), and it is not
caused by query length, `count`/`offset` values, `safesearch`, quoting, or
parentheses.

The application had already narrowed `country` to the five codes verified from
documentation (`VERIFIED_BRAVE_COUNTRY_CODES`) and every other region already
used query-and-host targeting, so the current control flow no longer sends
`SI`-style values. The provider itself had no guard, which left the 422
reachable by any future caller passing `countryCode` directly.

## Fix

`src/infrastructure/brave-search-provider.ts`:

- Added `BRAVE_SUPPORTED_COUNTRY_CODES` — the complete enum returned by the API
  above — and `isBraveSupportedCountryCode()`.
- `searchPage` now omits any `country` value outside that enum instead of
  forwarding it. The region keeps its `site:`-scoped, region-named query, so
  discovery continues instead of failing the run. `requestMetadata.countryCode`
  reports only a value that was actually sent.
- Added bounded exponential backoff for provider-side availability signals
  (`429`, `500`, `502`, `503`, `504`): at most three attempts, `Retry-After`
  seconds when Brave sends it, otherwise 1 s then 2 s, capped at 10 s. A
  deterministic `422` is deliberately **not** retried.

`src/application/research-discovery.ts`:

- A failed search request now emits a sanitized `stage: 'brave_search'`,
  `outcome: 'search_failed'` diagnostic — rejection reason, target mode, HTTP
  status, Brave error code/id, and request ID — before the run aborts, so a
  provider failure is recorded instead of appearing as an empty run.

`src/application/automatic-discovery.ts` and `app/(owner)/discovery/page.tsx`:

- A run that fails on a provider request is stored as `provider_rate_limited`
  (HTTP 429) or `provider_error`, and the workspace run list renders
  `Provider rate limited/error` instead of a bare `http_status`. Search-failure
  diagnostics are no longer written as per-result records.

`src/interfaces/discover-professor-batch.ts` and `app/actions.ts`:

- The manual batch summary now reports `providerHealth`
  (`ok` / `provider_rate_limited_or_error`) and each search failure carries
  `providerStatus`, `statusCode`, and `braveErrorCode`; the workspace run
  discovery action persists the same diagnostics.

## Verification

- `npm run typecheck` — passed (exit 0).
- `npm test` — 297 tests, 296 passed, 0 failed, 1 skipped (the opt-in MongoDB
  integration test).
- Live probe: the twelve sanitized requests above, 2026-11-20.
- `npm run discovery:preflight` — `{"ok":true,"profilePreferencesRead":true,
  "profileCountriesConfigured":true,"leadIdsRead":true,"leadCount":12}`.

## Remaining risks and follow-ups

- `VERIFIED_BRAVE_COUNTRY_CODES` still limits API country targeting to `AR`,
  `AU`, `AT`, `DE`, `US`. Brave's enum is now known and wider; widening
  targeting changes result quality and belongs with the allowlist/throughput
  decisions (R5, R7), not with this fix.
- Historical records keep their bare `statusCode: 422`; those requests cannot
  be retroactively attributed.
- The retry policy covers availability responses only; transport errors
  (DNS/TLS/timeouts) still fail the run immediately and are retried at the run
  level.
- No new search request was made for a region whose code is unsupported by
  Brave, so post-fix throughput is not yet measured.
