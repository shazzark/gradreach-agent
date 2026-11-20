# Phase 8 — Discovery operating envelope (R5)

Date: 2026-11-20
Audit items: `AUDIT.md` A-03 ("The 200-professor objective is unreachable at current throughput") and `R5` ("Decide and document the discovery operating envelope").

## Decision

Raise the automatic-discovery envelope so the 200-professor objective is reachable, make the schedule
active by default, and add a hard daily search-request ceiling so a stuck scheduler cannot run up an
unbounded provider bill.

The provider defect that made this unsafe is closed: unsupported Brave `country` values no longer abort
a run, 422 is never retried, and 429/5xx use bounded backoff
(`docs/phase-6-brave-422-diagnosis.md`).

## The envelope

| Setting | Before | After | Meaning |
|---|---|---|---|
| `DISCOVERY_LIMITS.searchesPerRun` | 1 | **5** | Ceiling on search requests in one due run. Targeting uses one query and one search per country, so a batch run of five countries spends five requests and a single-country run spends one. |
| `DISCOVERY_LIMITS.resultsPerSearch` | 3 | **10** | Brave `count` per request, and the number of result diagnostics retained per run. |
| `DISCOVERY_LIMITS.inspectionsPerRun` | 5 | **20** | Official pages fetched and dated evidence packages persisted per run (`/leads` inspection and scheduled runs share this bound). |
| `MAX_DAILY_SEARCHES` | — (new) | **20** | Hard ceiling on search requests per schedule-local calendar day, counted from persisted runs. |
| `DEFAULT_DISCOVERY_SCHEDULE.enabled` | `false` | **`true`** | A schedule record that does not exist yet is treated as enabled. |
| `DEFAULT_DISCOVERY_SCHEDULE.paused` | `true` | **`false`** | The default schedule runs rather than sitting paused. |
| `DEFAULT_DISCOVERY_SCHEDULE.frequency` | `weekly` | **`daily`** | One due slot per day at 09:00 in `Africa/Lagos` (timezone unchanged). |
| `DEFAULT_DISCOVERY_SCHEDULE.countries` | `[]` | `[]` (now meaningful) | An empty list means every configured country with a verified official host, visited in saved order. |

The daily sending cap (maximum five emails per configured local day) is untouched. Discovery still only
writes unverified, unapproved leads and cannot approve a professor, queue a draft, or send mail.

## Why these numbers

- **200 target:** 20 inspections per run × 10 fully successful runs = 200 inspected official profiles, versus
  the previous 5 per run that needed at least 40 runs (and, at the measured Brave failure rate, hundreds).
- **5 searches per run:** a one-sweep batch claims up to five countries (`DISCOVERY_COUNTRY_BATCH_SIZE = 5`)
  and spends exactly one search per country, so five is the batch ceiling rather than an arbitrary multiple.
- **10 results per request:** Brave accepts up to 20; 10 keeps the per-request payload and the retained
  diagnostic budget proportionate while tripling the previous three.
- **42 verified countries / 5 per batch = 9 batch runs** to visit the audited pool once. Ten full runs is
  therefore also the right order of magnitude for one country-pool pass plus one inspection pass.
- **20 searches per day** is the cost guard, not a throughput target. Normal operation is one due slot per
  day, so the expected spend is five searches (batch mode) or one (single-country mode).

Regions × runs × expected saves (upper bounds; the evidence gates decide actual saves):

| Scope | Runs | Search requests | Raw results | Page inspections | Save ceiling |
|---|---|---|---|---|---|
| One single-country run | 1 | 1 | 10 | 20 | 20 |
| One five-country batch run | 1 | 5 | 50 | 20 | 20 |
| Ten runs | 10 | 50 | 500 | 200 | 200 |
| One pass over all 42 verified countries (batch mode) | 9 | 45 | 450 | 180 | 180 |
| One local day, normal schedule | 1 | ≤5 | ≤50 | ≤20 | 20 |
| One local day, hard ceiling | ≤20 | 20 | 200 | ≤400 | — |

These are ceilings, not a forecast. Historical pilots converted 104 raw results into zero fully qualified
saves, so pool growth is still governed by the exact-host, identity, research-quote, interest, and duplicate
gates. Widening the allowlist per region (R7) is the accepted way to raise the raw-result yield.

## Schedule status

The schedule is now active by default: `enabled: true`, `paused: false`, `daily` at `09:00` in
`Africa/Lagos`, with no country restriction. Behaviour that did not change:

- The worker process still needs its own deployment opt-in, `GRADREACH_DISCOVERY_SCHEDULER_ENABLED=true`
  (`src/interfaces/discovery-scheduler.ts`). No workstation runs discovery merely because the repository is
  checked out, and the default does not spend provider credit until the owner starts the worker.
- Each due slot is claimed once (`discovery:<local slot>`), so restarting the worker mid-slot cannot repeat a
  run; a repeated attempt returns `duplicate`.
- The owner can pause, disable, change frequency/time/timezone, or restrict countries from `/discovery`.
  Pause is evaluated before any provider call. `/discovery` shows the active limits and the daily ceiling.
- A saved schedule that lists countries keeps that narrower scope; only an empty list falls back to every
  configured verified country.

## Daily budget guard

`MAX_DAILY_SEARCHES = 20` is enforced in `runAutomaticDiscovery` before a slot is claimed:

- `searchesUsedOnDay(schedule, runs, now)` sums `counts.searches` from persisted runs whose `startedAt` falls on
  the current schedule-local date. Runs without a parseable timestamp are ignored, so legacy records cannot
  inflate the count.
- When the day is spent, the run returns `state: 'budget_exhausted'` with `searchesUsedToday`, makes no
  provider call, and leaves the slot unclaimed. The worker prints that state instead of a silent no-op.
- Inside a run, the per-country `maxSearches` is the smaller of `DISCOVERY_LIMITS.searchesPerRun` and the
  remaining daily budget. A partially spent day truncates or shortens a batch; countries that were not
  searched stay queued for the next slot instead of being marked attempted.
- Worst case for a day is 20 search *calls*. Each call can be attempted at most three times by the provider
  adapter on 429/5xx (never on 422), so observable HTTP requests stay at or below 60.

## Verification

- `npm run typecheck` — exit 0.
- `npm test` — 301 tests, 300 passed, 1 opt-in MongoDB integration test skipped, 0 failed (2026-11-20).
- Focused: `node --experimental-strip-types --test test/automatic-discovery.test.ts` — 20/20.
- New/updated tests in `test/automatic-discovery.test.ts`:
  - default schedule is enabled, unpaused, daily, and validates with no country selection;
  - `MAX_DAILY_SEARCHES` is 20 and `inspectionsPerRun × 10` is 200;
  - `searchesUsedOnDay` counts only the schedule-local day and ignores unparseable timestamps;
  - a spent budget returns `budget_exhausted`, calls no provider, and leaves the slot unclaimed;
  - a partially spent budget truncates a batch to its remaining searches and keeps unsearched countries queued;
  - an enabled schedule with no country selection rotates through configured verified countries.
- No live provider request, scheduler start, MongoDB write, or email was performed for this change. The
  numbers above are enforced constants and unit-tested behaviour, not measured live throughput.

