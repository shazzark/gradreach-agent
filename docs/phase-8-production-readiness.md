# Phase 8 — Script cleanup and production startup

Closes audit items R10 (script sprawl plus a hardcoded `Canada` allowlist) and R12 (production
startup depended on `node --experimental-strip-types`). No provider was called, no email was sent,
no scheduler was started, and nothing was deployed by this work.

## R10 — `ops:*` / `debug:*` script taxonomy

Every entry point now declares whether it is a durable operation or a one-off investigation helper.

| Old script | New script | Kind |
|---|---|---|
| `app` | `ops:terminal-app` | compiled |
| `db:indexes` | `ops:db-indexes` | compiled |
| `db:migrate-discovery` | `ops:db-migrate-discovery` | compiled |
| `discovery:batch` | `ops:discovery-batch` | compiled |
| `discovery:pilot` | `ops:discovery-pilot` | compiled |
| `discovery:preflight` | `ops:discovery-preflight` | compiled |
| `discovery:scheduler` | `ops:discovery-scheduler` | compiled |
| `confirmed-professors:enrich` | `ops:enrich-confirmed-professors` | compiled |
| `gmail:connect` | `ops:gmail-connect` | compiled |
| `gmail:self-test` | `ops:gmail-selftest` | compiled |
| `leads:reprocess` | `ops:leads-reprocess` | compiled |
| `outreach:scheduler` | `ops:outreach-scheduler` | compiled |
| `outreach:sync-replies` | `ops:sync-replies` | compiled |
| `leads:view` | `debug:leads-view` | source |
| `leads:inspect` | `debug:leads-inspect` | source |
| `leads:reprocess:audit` | `debug:leads-reprocess-audit` | source |
| `discovery:preview:country` (and the `:canada` alias) | `debug:discovery-preview:country` | source |
| `discovery:preview:continue` | `debug:discovery-preview:continue` | source |
| `discovery:preview:all` | `debug:discovery-preview:all` | source |
| `discovery:preview:canada:audit` | `debug:discovery-preview:audit` | source |
| `discovery:preview:canada:reevaluate` | `debug:discovery-preview:reevaluate` | source |
| `leads:review-preview:candidate-03` | `debug:leads-review-preview` | source |
| `leads:draft-preview:candidate-03` | `debug:leads-draft-preview` | source |

`test`, `test:mongodb`, `test:watch`, `typecheck`, `build`, `dev`, and `web` keep their names.

Rules that follow from the naming:

- `ops:*` and `start` always run `npm run build:server` first and then execute the compiled file in
  `dist/`, so a stale build cannot be served and no experimental Node flag is required.
- `debug:*`, `dev`, and the test scripts still run TypeScript sources and therefore still pass
  `--experimental-strip-types`. They are development tools; they are not the production path.
- Script names in earlier dated audit and plan entries are left untouched: they record what was run
  at that time. This table is the mapping for anything older than this section.

### Region instead of a hardcoded allowlist

`src/application/candidate-review-preview.ts` no longer reads `OFFICIAL_HOSTS_BY_REGION.Canada`.
`compareSavedLeadDuplicates` and `stableProfileCandidateId` take the region as an argument, and
`resolveReviewRegion` picks it in this order:

1. `--region <name>` or `--region=<name>`, the same syntax the discovery pilot uses;
2. `GRADREACH_REVIEW_REGION`;
3. `Canada` as a documented default, announced with a one-line stderr warning that names both
   alternatives.

An unknown region fails closed: no host is treated as official, so a duplicate check returns
`could not verify` rather than `not found`. The resolved region is written to the private report and
to the JSON status lines so a run can be told apart afterwards. The saved-evidence paths and the
recorded `University of Waterloo` identity remain specific to this single-candidate preview, which is
why the command is now a `debug:` tool.

## CI

The `verify` job gained a `npm run build:server` step so a broken production compile fails the pull
request. Its name deliberately stays `Typecheck and unit tests`: that exact string is a required
status-check context in `main` branch protection, and renaming the job leaves the required check
permanently unreported, which blocks every pull request without an obvious cause.

## R12 — production startup no longer needs an experimental flag

Decision: compile the server entry points with `tsc` and run the emitted JavaScript.

- `tsconfig.build.json` extends `tsconfig.json` with `noEmit: false`, `rootDir: src`,
  `outDir: dist`, `allowImportingTsExtensions: false`, and `rewriteRelativeImportExtensions: true`,
  and includes only `src/interfaces/**/*.ts`. That covers all entry points and everything they
  import; nothing outside `src` is emitted.
- `npm run build:server` is new. `npm start` and every `ops:*` script run it before launching, so the
  compiled tree is always current for the code being started.
- `dist/` was already gitignored. No build output is committed.

Why not keep `node --experimental-strip-types`: the flag is experimental, its default and behaviour
have changed across Node 22 minors, and a worker that depends on an experimental loader can fail on
a minor upgrade with a syntax error that names no GradReach file. The compiled path runs on stable
Node semantics.

### Runtime guard

`src/infrastructure/runtime-support.ts` classifies the executing module from `import.meta.url`:

- a `*.ts`/`*.tsx` source needs Node's type stripping (`process.features.typescript` reporting
  `strip`/`transform`, or an explicit `--experimental-strip-types` in `execArgv`/`NODE_OPTIONS`);
- a `dist/` file needs only Node.js 22 or newer;
- anything else, including a Next.js server bundle, is not checked, so importing the guard from a
  website route cannot change website behaviour.

The guard runs from `src/infrastructure/local-env.ts` (imported by every CLI entry point) and from
`runWebServer` at the top of the production server. A failure throws `RuntimeSupportError` with code
`node_version_unsupported` or `typescript_runtime_unavailable` and a message that names the running
version and the fix.

## Limits

- The compiled path was verified locally on Windows with the owner's Node version. No deployment
  host, container, or CI production start has been exercised; the hosted start command is documented
  but unproven.
- `ops:*` and `start` need `typescript` at start-up time, so the host must install development
  dependencies (`npm ci`, not `npm ci --omit=dev`) or pre-run `npm run build:server`. `npm run build`
  already needs them for `next build`.
- `debug:*` scripts remain source-run and still need a Node that can strip types.
- Nothing here sends email, starts a scheduler, or changes the five-per-day cap.

## Verification (2026-11-21, Windows, Node 22.13)

- `npm run typecheck` exit 0.
- `npm run build:server` exit 0; 66 files in `dist/`, zero `.ts` import specifiers in the output,
  zero stray `.js` files in the source tree.
- `node -e "await import('./dist/interfaces/prepare-candidate-review-preview.js')"` loaded the
  compiled entry on plain Node with no experimental flag.
- `npm run ops:discovery-pilot` (no region argument) built, started the compiled file, and exited 1
  with `{"ok":false,"stage":"pilot_configuration","kind":"invalid_request"}` — a graceful failure,
  not `Missing script`.
- `npm test` 347 tests, 346 passed, 1 opt-in MongoDB test skipped, 0 failed. New tests:
  `test/runtime-support.test.ts` and the region cases in `test/candidate-review-preview.test.ts`.
- Merged as [PR #7](https://github.com/shazzark/gradreach-agent/pull/7) by rebase on 2026-11-21; `main` is at `082deb7`.
  PR checks `Typecheck and unit tests` (24 s) and `MongoDB integration` (40 s) passed in run `44842676358`, and the
  post-merge push run `44842796061` succeeded in 49 s. The first merge attempt was blocked because the verify job had been
  renamed away from its required status-check context; the rename was reverted before merging.
