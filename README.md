# [afterhoursoutreach.ca](https://afterhoursoutreach.ca)

The After Hours Outreach Initiative website, built with Astro and hosted on
Cloudflare Workers.

## Setup

```sh
pnpm install
```

## Local documentation

Browse the project guides in a separate Astro + Starlight development server:

```sh
pnpm docs:dev
```

Open <http://127.0.0.1:4322>. The server runs in the background, independently of
the application server on port 4321. It needs no Wrangler setup, database, or
application secrets.

| Command            | Purpose                          |
| ------------------ | -------------------------------- |
| `pnpm docs:stop`   | Stop the documentation server.   |
| `pnpm docs:status` | Show its address and status.     |
| `pnpm docs:logs`   | Read its logs.                   |
| `pnpm docs:check`  | Validate the documentation site. |

Edit Markdown in [docs/src/content/docs/](docs/src/content/docs/); changes appear
live in the browser. Each page has `title` and `description` frontmatter; Starlight
provides the page title, so start body headings at `##`. Update the sidebar in
`docs/astro.config.mjs` when adding a page. Use documentation routes such as
`/testing/` for links between guides, and explicit repository links for source
files outside the documentation site.

After changing the site configuration, restart the reader with `pnpm docs:stop`
followed by `pnpm docs:dev`.

The documentation package is private and local-only, with no deployment command
or Cloudflare adapter. The application's build and deploy commands do not include
it. Navigation and page contents are available in dev; build-dependent full-text
search is intentionally disabled. Benchmark data stays in `docs/benchmarks/`.

## Tests

Run `pnpm test` for Vitest unit and Cloudflare runtime tests, or
`pnpm test:watch` during development. Built-Worker and Playwright commands are
documented in the [testing guide](docs/src/content/docs/testing.md).

## Test benchmarks

The [test benchmark report](docs/src/content/docs/test-benchmarks.md) records the baseline test
counts, suite/build runtimes, and per-test timings. It includes commands for
rerunning `pnpm test:benchmark` and comparing changes with the saved baseline.

The [simplified-suite comparison](docs/src/content/docs/test-benchmarks-simplified.md) records the
results after removing cosmetic assertions and consolidating duplicate flows.

The [Vitest migration comparison](docs/src/content/docs/test-benchmarks-vitest.md) records the
Cloudflare runtime migration and compares it with both saved snapshots.
