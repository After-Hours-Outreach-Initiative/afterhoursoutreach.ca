---
title: Docs site
description: Run, navigate, and maintain the local Starlight documentation site.
---

This is a standalone, local-only Starlight site. It is not deployed or included
in the application build. Reading and checking the docs requires no Wrangler,
database, Cloudflare credentials, or application secrets, and does not require
starting the application server.

The optional [Operations dashboard](/dashboard/) adds privileged, local-only
administration of remote D1 databases and monitoring of Resend limits. It uses
Wrangler credentials separately from ordinary reading; see
[Dashboard administration](/operations-dashboard/) for setup and safeguards.

## Read locally

Run these commands **from the repository root**, not from `docs/`:

```sh
pnpm install
pnpm docs:dev
```

Open [http://127.0.0.1:4322](http://127.0.0.1:4322). The documentation server runs in
the background, binds only to loopback, and fails if port 4322 is already in use
instead of choosing another port.

Manage the documentation server from the repository root:

| Command            | Purpose                                   |
| ------------------ | ----------------------------------------- |
| `pnpm docs:status` | Check whether the docs server is running. |
| `pnpm docs:logs`   | Read the docs server logs.                |
| `pnpm docs:stop`   | Stop only the docs server.                |
| `pnpm docs:check`  | Validate the docs project and content.    |

## Navigation and search

Navigate using the sidebar, the [project overview](/), and each page's table of
contents. The sidebar's **Historical benchmarks** group is collapsed by default.

Pagefind requires a production build, so search is disabled for this dev-server
reader; there is no custom search service.

## Edit the documentation

The canonical documentation source is `docs/src/content/docs/`. Edit the Markdown or MDX
files there directly rather than creating duplicate guides elsewhere in `docs/`.
The local reader updates as you save changes.

Use standard Markdown with `title` and `description` frontmatter:

```md
---
title: Guide title
description: A brief explanation of what this guide covers.
---

Introduce the guide here.

## First section

Write the section here.
```

Starlight renders the title as the page's H1, so do not repeat it as a `#` heading
in the body. Use lowercase, hyphen-separated filenames and keep routes
filename-based without custom `slug` frontmatter: `accounts.md` becomes
`/accounts/`, and `index.mdx` is the project overview at `/`. Link to reader routes
such as `[Accounts](/accounts/)`, not `.md` source paths. Add new guides to the
explicit sidebar in `docs/astro.config.mjs`, then run `pnpm docs:check`.

After changing the site configuration, restart the reader with `pnpm docs:stop`
followed by `pnpm docs:dev`.

## Diagrams

Diagrams are native `.excalidraw` files in `docs/public/diagrams/`. These files are
the source of truth for the editor; there is no
separate image to keep synchronized. Excalidraw and its fonts are served locally,
without an account, diagram service, or CDN. Fonts are copied from the installed
package when `pnpm docs:dev` starts.

Diagrams use left-to-right layouts in a 16:9 editor that opens when the
page loads. Controls sit above the editor on the right; an optional caption sits
below it. There is no separate preview or edit mode to open.

The `.excalidraw` filename appears at the top left of each diagram. Click it or
its copy icon to copy the filename to the clipboard.

### Edit a diagram by hand

1. Open its docs page; the Excalidraw editor is already available.
2. Move shapes, change labels, and adjust connectors directly on the canvas.
   Undo/redo works inside the focused editor with the usual keyboard shortcuts.
3. **Fit diagram** brings all shapes back into view without changing the diagram.
4. **Save** writes the current scene, including its embedded logos, to the matching
   `.excalidraw` file in `docs/public/diagrams/`. The controls show when saving
   succeeds or fails. Saving does not reload the page or clear undo history.
5. **Reset to saved** restores the most recently saved scene, or the scene loaded
   from disk if you have not saved yet. Reset is itself undoable.

Saving is explicit, not automatic. Unsaved changes are discarded on reload or
navigation; saved changes persist and appear as ordinary Git changes. Commit
those changes when ready. The embedded editor's **Open** menu item can load a
local scene, and **Save** replaces the diagram associated with that docs page.

The save endpoint exists only in the local development server. It accepts
same-origin requests from loopback addresses and only updates existing regular
`.excalidraw` files in the diagrams directory. Saves are atomic. If a file changes
on disk after loading, saving refuses to overwrite it and reports the conflict.
There is no hosted storage, download step, or collaboration service.

Diagram file changes do not automatically reload the page, so saving one diagram
does not discard work in another. Reload to see edits made outside the browser.
Restart the docs server after adding a new diagram file so it becomes available
to the save endpoint.

### Embed a diagram

Use an `.mdx` page and import the shared component. The filename still determines
the route; changing `.md` to `.mdx` does not change the URL.

```mdx
import Diagram from "../../components/Diagram.astro";

<Diagram
  name="system-overview"
  title="System overview"
  description="Explain the diagram's relationships in text for readers who cannot see the canvas."
  caption="An optional caption displayed below the editor."
/>
```

`name` selects `docs/public/diagrams/system-overview.excalidraw`. The title and
description provide accessible text; they are not displayed as a heading or
caption. Omit `caption` when no visible caption is needed. Use short labels and
split different levels of detail into separate diagrams. Label repository nodes
with the repository name, and include "Worker" in labels for Worker entry points
and deployment targets.

Logos are embedded SVG image elements in each native diagram, not external image
links. GitHub, Cloudflare, Resend, Astro, Better Auth, and Drizzle marks are included
where relevant. They are stored inside the native scene, work offline,
and are grouped with their nodes so moving a node also moves its logo. Keep text
labels alongside logos; do not rely on a logo alone to identify a service.

Branded boxes use larger 56×56 logos on the left, followed by left-aligned text
with a consistent gap. These labels are grouped with the box and logo rather
than bound to the entire box, so Excalidraw does not re-center them over the logo.

The GitHub and other monochrome marks come from Simple Icons (CC0), and the
Cloudflare mark comes from SVG Logos (CC0), distributed through Iconify. Brand
names and trademarks remain the property of their owners.

### Agent edits

Edit the existing `.excalidraw` JSON instead of regenerating the diagram. Preserve
element IDs, positions, container text bindings, and arrow bindings unless the
requested change needs them to move. This preserves hand-tuned layouts.

Preserve embedded logo assets and their node groups when editing a scene. Do not
write or run tests for this documentation site; see the repository's `AGENTS.md`.

Keep authoring instructions on this page, the high-level system map on
[Overview](/), and detailed system diagrams on their architecture pages.
