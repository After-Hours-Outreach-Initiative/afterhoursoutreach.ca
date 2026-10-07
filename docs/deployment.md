# Deployment

- Domain: [afterhoursoutreach.ca](https://afterhoursoutreach.ca)
- DNS registrar: Porkbun
- DNS manager: Cloudflare DNS
- Hosting: Cloudflare Worker named `afterhoursoutreach-ca`
- Codebase:
  https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca

## Branch previews

- Public Workers Previews under `afterhoursoutreach-ca`, not version URLs.
- Config: `previews` in `wrangler.jsonc`; Wrangler 4.135.0.
- URL: `<branch-slug>-afterhoursoutreach-ca.ivanzheng9905.workers.dev`.
- All previews share D1 `afterhoursoutreach-staging` unless their bindings and
  `wrangler.preview-migrations.jsonc` both specify a separate database.

Run `pnpm deploy:preview` to build, migrate the preview database, and run
`wrangler preview`. The preview name defaults to the Git branch.
`pnpm preview` remains local Astro previewing.

After migrations, run `pnpm db:seed:preview` to add six synthetic volunteers,
five upcoming sample events (including full, closed, and hidden examples), and
four orientation signups to the shared preview database. Names and meeting points
are labelled as samples; email addresses use the non-deliverable `.invalid` domain.
The command verifies the preview binding and refuses production targets. It
preserves existing accounts, fixture edits, and signup cancellations, and does not
run automatically during builds or deployments. Dates are relative to the first
seed run; rerunning does not reschedule existing events.

Seeding sends no email and creates no sign-in credentials, sessions, patrol
approvals, or organizer roles. Use `pnpm organizer:bootstrap --preview --email
verified@example.org` for your own verified, registered preview account if the
database has no organizer yet. Volunteer-management pages remain organizer-only.

`pnpm build` includes all account and event features for production. There is no
account feature flag or preview-host restriction. `pnpm build:preview` uses the
same application with a preview banner and a separate output directory; preview
mode does not gate any features. Development account controls and simulated
emails are excluded from both builds.

Sign-in URLs use `AUTH_BASE_URL` when configured, otherwise the request origin.
Production pins this to `https://afterhoursoutreach.ca`; previews leave it empty
to use their own URL. Forwarded-host headers are never used. Account pages keep
their CSP, no-store, and noindex protections in all deployed builds; public
production pages can be indexed and cached.
Account secrets: `BETTER_AUTH_SECRET`, `RESEND_API_KEY`.
Use `wrangler preview base-config secret put NAME` for new previews, or
`wrangler preview secret put NAME --name BRANCH` for an existing preview.
Account secrets are configured in Previews Base. Email requests remain rate limited.
`pnpm test:accounts` uses local data only.
`pnpm test:preview` checks the preview build, including its banner, using a local
Worker and local test database.

Production: `pnpm deploy`. The developer controls when to deploy; there is no
custom pre-deployment gate. Before doing so, replace the placeholder production
D1 ID in `wrangler.jsonc`, apply its migrations, configure the account secrets,
and finish the privacy-policy review. Never point production at the shared
preview database. Builds and tests do not deploy anything. Preview deployments
never deploy production code.
The separate `afterhoursoutreach-ca-staging` Worker and `staging.afterhoursoutreach.ca`
domain were retired after live preview checks; the shared D1 database was retained.
