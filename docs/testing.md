# Testing

Non-browser tests use Vitest, configured in `vitest.config.ts`. Playwright
remains the browser runner.

## Commands

| Command               | Coverage                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| `pnpm test`           | Node utility/schema/fixture tests and source-level Cloudflare runtime tests           |
| `pnpm test:watch`     | Watch the same unit and runtime projects                                              |
| `pnpm test:accounts`  | Build production, then test the actual Worker and its browser flows                   |
| `pnpm test:preview`   | Build preview, then test the actual preview Worker                                    |
| `pnpm test:ui`        | Browser tests with an automatically started server and disposable local D1 database   |
| `pnpm test:benchmark` | Isolated local browser setup, builds and all test projects, with saved timing reports |

Run a single source-level file with, for example:

```sh
pnpm exec vitest run --project runtime tests/auth.test.ts
pnpm exec vitest --project unit tests/event-time.test.ts
```

Built-Worker projects need fresh artifacts first; their package commands do
this automatically. Those suites retain the original ordered workflows with
shared fixtures, so run the entire file rather than filtering out prerequisite
cases. Files still run in parallel.

## Cloudflare runtime tests

The `runtime` project uses `@cloudflare/vitest-plugin` to execute auth and D1
tests inside `workerd`, with a real local D1 binding. Tests import bindings from
`cloudflare:workers`. `tests/helpers/runtime-setup.ts` resets storage before
every case and applies the repository's actual SQL migrations using
`readD1Migrations` and `applyD1Migrations`.

The plugin configuration is deliberately test-only: no deployed Worker entry
point, remote bindings, developer `.dev.vars`, or persisted development D1
database. Its compatibility date and `nodejs_compat` flag match
`wrangler.jsonc`; keep these synchronized when changing the deployment target.
Auth/email fixtures use synthetic credentials and injected delivery callbacks.

Vitest normally sets `import.meta.env.DEV=true`. The runtime setup overrides
`DEV=false` and `PROD=true` before application imports so source-level security
tests exercise deployed behavior. Development controls are tested separately
by the local Playwright suite.

The plugin is pinned to `1.3.1`: newer releases had unavailable Wrangler or
Miniflare dependencies in the registry when this migration was installed.
Vitest remains on compatible 4.x because the plugin requires `^4.1.0`.
The project's deployment Wrangler stays pinned at its existing version.

## Built artifacts and browsers

The `worker` and `preview` projects use Node-hosted Vitest and Wrangler's
`createTestHarness` to exercise the generated Astro Worker, assets, migrations,
and production/preview security behavior. Keeping these checks catches build
and deployment regressions that source-level runtime tests cannot catch.
Their embedded Playwright flows remain intact; the separate `tests/ui/`
development and deployed read-only smoke tests also remain on Playwright.

Run `pnpm test:ui` without starting a server. Both this command and the benchmark
create their own temporary copy of the current working tree, synthetic fixtures,
local secrets, and fresh migrated D1 database. Astro runs in background mode on
an unused port. The server is stopped and its temporary directory removed after
the run, including failed tests. `pnpm test:ui` also handles Ctrl-C and SIGTERM.
Neither command reuses, changes, or stops your development server/database.
Existing test accounts in your development database are not deleted.

Playwright arguments are forwarded normally:

```sh
pnpm test:ui tests/ui/local-accounts.spec.ts
pnpm test:ui --grep "registration"
```

Local `PLAYWRIGHT_BASE_URL` overrides and the benchmark's former `--local-url`
option are rejected to prevent accidental writes to a persistent dev database.
Use `pnpm test:ui`, not bare `pnpm exec playwright test`, for local runs. Setup
logs are retained under `test-results/ui/` (or `test-results/benchmarks/`). A hard
process kill can leave a temporary directory/server behind, but cannot add
accounts to your normal development database.

An explicit HTTPS origin runs only the read-only deployed smoke suite and does
not create a local database:

```sh
PLAYWRIGHT_BASE_URL=https://your-preview.workers.dev pnpm test:ui
```

## Benchmark comparisons

Preserve the original [baseline](test-benchmarks.md) and
[simplified-suite snapshot](test-benchmarks-simplified.md). The
[Vitest migration snapshot](test-benchmarks-vitest.md) records the passing
post-migration benchmark and its comparisons. Compare future changes with:

```sh
pnpm test:benchmark --baseline docs/benchmarks/test-vitest.json --deployed-url https://feat-patrol-scheduling-mockup-afterhoursoutreach-ca.ivanzheng9905.workers.dev
```

Vitest JSON supplies leaf-test counts and individual timings. Unlike the old
Node runner, Vitest does not count parent suites as extra tests. Reports show
both leaf and legacy container counts, retain per-file leaf execution spans,
and flag failed suite hooks even if leaf assertions passed. Five regression
cases protect the benchmark parser/reporting behavior.

The event workflow's new `with scheduled events` fixture suite changes the full
names of its descendants without removing assertions. Treat those inventory
name changes as regrouping, not removed coverage. Vitest leaf timings exclude
suite-level hooks; its JSON per-file span also excludes outer `beforeAll` and
`afterAll`. Compare end-to-end phase wall times to capture full fixture and
runner costs, not just case durations.
