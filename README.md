# [afterhoursoutreach.ca](https://afterhoursoutreach.ca)

The After Hours Outreach Initiative website, built with Astro and hosted on
Cloudflare Workers.

## Setup

Use Node.js 24.22.2 (see `.node-version`) and pnpm 11.9.0. Current timezone data
keeps Vancouver event times consistent with the Workers runtime after B.C.'s
2026 move to permanent UTC−7.

```sh
pnpm install
```

## Home-screen icons

iOS uses `public/apple-touch-icon.png`; Android uses the regular and maskable
icons declared in `public/site.webmanifest`. The shared site layout links both.

To change the home-screen artwork, replace `public/icons/app-icon.svg` with a
square SVG and run `pnpm icons:generate`. Commit the generated PNGs alongside
the source. Keep the artwork centered with padding so Android's icon masks
don't crop it. Browser favicons are managed separately.

## Local UI playground

Run `pnpm dev`, then open <http://localhost:4321/dev/ui> or choose **UI playground**
in the local **DEV panel** (Alt+Z), available on every page, including the
playground. Account controls load only when the panel is opened.

Choose a website part from the playground navigation:

- **Applications table** (`/dev/ui/applications`): try application progress states,
  approval filters, instant local search, empty results, long names, and 500-entry directories.
- **Volunteers table** (`/dev/ui/volunteers`): inspect roles, avatars, patrol access,
  and ascending/descending sorting on all three columns. Both table playgrounds
  include viewport sizes and delayed, failed, or paused search/sort responses.
- **Organizer profile**: inspect application review, rejection, orientation,
  volunteer/medic access, organizer roles, and historical records. Preview
  the profile page at different sizes, try long or sparse answers, and
  simulate loading, failed saves, conflicts, pending actions, and email failures.
- **Discord connection**: browse the state gallery or try fictional inputs,
  delayed responses, and success/error flows. Developer controls simulate
  background updates without adding a refresh button to the actual component.

The previews use the website's real view components. Viewport settings and scenario URLs
can be bookmarked or shared locally; reset restores the selected fictional state.
The playground simulations need no sign-in and never change accounts, write to
the database, or call Discord. The shared DEV panel still provides its usual
local account controls. Playground routes and simulations are excluded from both
production and hosted preview builds. Add future component examples under
`src/dev/ui/`.

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

The reader separates [Planning](docs/src/content/docs/planning/index.md),
[Specification](docs/src/content/docs/specification/index.md), and
[Implementation](docs/src/content/docs/implementation/index.md). Plans hold proposals
and open decisions; specifications record agreed behavior; implementation guides
explain the code and operations.

Edit Markdown in [docs/src/content/docs/](docs/src/content/docs/); changes appear
live in the browser. Each page has `title` and `description` frontmatter; Starlight
provides the page title, so start body headings at `##`. Update the sidebar in
`docs/astro.config.mjs` when adding a page. Use documentation routes such as
`/implementation/testing/` for links between guides, and explicit repository links for source
files outside the documentation site.

After changing the site configuration, restart the reader with `pnpm docs:stop`
followed by `pnpm docs:dev`.

The documentation package is private and local-only, with no deployment command
or Cloudflare adapter. The application's build and deploy commands do not include
it. Navigation and page contents are available in dev; build-dependent full-text
search is intentionally disabled.

## Tests

Discord account linking and role synchronization require a dedicated bot,
server/role IDs, and private secrets. See the [Discord setup and operations guide](docs/src/content/docs/implementation/discord.md)
before enabling new applications. Email sign-in is unchanged; existing volunteers
retain access without a Discord link.

Run `pnpm test` for Vitest unit and Cloudflare runtime tests, or
`pnpm test:watch` during development. Built-Worker and Playwright commands are
documented in the [testing guide](docs/src/content/docs/implementation/testing.md).
