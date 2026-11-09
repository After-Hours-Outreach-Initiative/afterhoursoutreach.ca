---
title: Deployment
description: Branch preview and production deployment procedures, safeguards, and medic certification reminders.
---

- Domain: [afterhoursoutreach.ca](https://afterhoursoutreach.ca)
- DNS registrar: Porkbun
- DNS manager: Cloudflare DNS
- Hosting: Cloudflare Worker named `afterhoursoutreach-ca`
- Codebase:
  https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca

## GitHub builds

`main` is the production branch. Cloudflare Workers Builds is connected through
the **Cloudflare Workers and Pages** GitHub app; there is no checked-in GitHub
Actions deployment workflow. Successful GitHub checks confirm production builds
for `main` and preview builds for `feat/patrol-scheduling-mockup`.

Workers Builds uses separate build and deploy steps:

| Target     | Build command        | Deploy command        |
| ---------- | -------------------- | --------------------- |
| Production | `pnpm build`         | `pnpm deploy`         |
| Preview    | `pnpm build:preview` | `pnpm deploy:preview` |

Use the same two steps for manual deployments. Deploy scripts do not rebuild;
run the matching build first so its generated Wrangler configuration and assets
are current. Builds do not change remote databases or deploy Workers.

Both deploy scripts apply pending migrations to their guarded database target
before uploading the Worker. A migration failure stops deployment. Production
also runs `pnpm db:check` to validate the generated migration history. Keep
migrations compatible with the currently deployed Worker: migration and Worker
deployment are not atomic, and rolling back Worker code does not undo migrations.
Destructive schema changes and data backfills need a separately reviewed rollout.

Manage these CI settings with `cf` using its separate OAuth login; keep application
builds/deployments on the existing Astro and Wrangler scripts. Updating CI commands
does not deploy anything; script changes take effect when the built branch contains
them. Do not trigger a production build merely to validate configuration changes.

## Branch previews

- Public Workers Previews under `afterhoursoutreach-ca`, not version URLs.
- Config: `previews` in `wrangler.jsonc`; Wrangler 4.135.0.
- URL: `<branch-slug>-afterhoursoutreach-ca.ivanzheng9905.workers.dev`.
- All previews share D1 `afterhoursoutreach-staging` unless their bindings and
  `wrangler.preview-migrations.jsonc` both specify a separate database.

The pre-production migration history now starts at generated
`0000_database.sql`. A preview database that applied the old history must be
explicitly rebuilt before the next deployment; applying the new baseline over
existing tables fails. Export a backup first, then rebuild only the shared
non-production database identified by `wrangler.preview-migrations.jsonc`.
Rebuilding removes existing accounts, sessions, organizer roles, events, and
migration records. Reapply `pnpm db:migrate:preview` afterward. Seeding and
organizer bootstrap remain separate, explicit operations; no command resets
databases automatically. Never use this process for production data.

Run `pnpm build:preview` followed by `pnpm deploy:preview` to build, migrate the
preview database, and run `wrangler preview`. The preview name defaults to the Git branch.
`pnpm preview` remains local Astro previewing.

After migrations, run `pnpm db:seed:preview` to add six synthetic volunteers,
five upcoming sample events (including full, closed, and hidden examples), and
four orientation signups to the shared preview database. Names and meeting points
are labelled as samples; email addresses use the non-deliverable `.invalid` domain.
The command verifies the preview binding and refuses production targets. It
refreshes incomplete synthetic sample profiles without submission snapshots,
then preserves their snapshots and subsequent edits; existing accounts, event
edits, signup cancellations, and unrelated records remain untouched. It does not
run automatically during builds or deployments. Dates are relative to the first
seed run; rerunning does not reschedule existing events.

Seeding sends no email and creates no sign-in credentials, sessions, patrol
approvals, or organizer roles. Use `pnpm organizer:bootstrap --preview --email
verified@example.org` for your own verified preview account with a completed application if the
database has no organizer yet. Volunteer-management pages remain organizer-only.

`pnpm build` includes all account and event features for production. There is no
account feature flag or preview-host restriction. `pnpm build:preview` uses the
same application with a preview banner and a separate output directory; preview
mode disables Discord connections and role-sync side effects. Development account controls and simulated
emails are excluded from both builds.

Sign-in URLs use `AUTH_BASE_URL` when configured, otherwise the request origin.
Production pins this to `https://afterhoursoutreach.ca`; previews leave it empty
to use their own URL. Forwarded-host headers are never used. Account pages keep
their CSP, no-store, and noindex protections in all deployed builds; public
production pages can be indexed and cached.
Account secrets: `BETTER_AUTH_SECRET`, `RESEND_API_KEY`.
Discord additionally needs private client/bot/encryption secrets and the server
and three role IDs documented in [Discord setup](/implementation/discord/#dedicated-bot-and-server-setup).
Blank IDs disable Discord without affecting email sign-in; configure before
accepting new applications. No production Discord credentials belong in previews.
Use `wrangler preview base-config secret put NAME` for new previews, or
`wrangler preview secret put NAME --name BRANCH` for an existing preview.
Account secrets are configured in Previews Base. Email requests remain rate limited.
`pnpm test:accounts` uses local data only.
`pnpm test:preview` checks preview account behavior and rejection of development
endpoints using a local Worker and test database. See [Testing guide](/implementation/testing/)
for the Vitest projects and browser-test commands.

Production: `pnpm build` followed by `pnpm deploy`. The deploy script applies
guarded production migrations before deploying `dist/server/wrangler.json`.
Before doing so, verify the dedicated production D1 binding in `wrangler.jsonc`,
configure the account secrets, and finish the privacy-policy review. These launch
approvals remain the developer's responsibility, not an automated script gate.
Never point production at the shared preview database. Builds and tests do not
deploy anything. Preview deployments never deploy production code.
The separate `afterhoursoutreach-ca-staging` Worker and `staging.afterhoursoutreach.ca`
domain were retired after live preview checks; the shared D1 database was retained.

## Medic certification reminders

Cron configuration, outbox behavior, and monitoring are documented under
[Notification delivery](/implementation/notifications/#medic-certification-reminders).
The product timing and eligibility rules live in the
[Notifications specification](/specification/notifications/#medic-certification-reminders).
