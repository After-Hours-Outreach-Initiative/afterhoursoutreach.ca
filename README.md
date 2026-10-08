# [afterhoursoutreach.ca](https://afterhoursoutreach.ca)

The After Hours Outreach Initiative website, built with Astro and hosted on
Cloudflare Workers.

## Setup

```sh
pnpm install
```

Documentation is in [docs/](docs/).

## Tests

Run `pnpm test` for Vitest unit and Cloudflare runtime tests, or
`pnpm test:watch` during development. Built-Worker and Playwright commands are
documented in [docs/testing.md](docs/testing.md).

## Test benchmarks

The [test benchmark report](docs/test-benchmarks.md) records the baseline test
counts, suite/build runtimes, and per-test timings. It includes commands for
rerunning `pnpm test:benchmark` and comparing changes with the saved baseline.

The [simplified-suite comparison](docs/test-benchmarks-simplified.md) records the
results after removing cosmetic assertions and consolidating duplicate flows.

The [Vitest migration comparison](docs/test-benchmarks-vitest.md) records the
Cloudflare runtime migration and compares it with both saved snapshots.
