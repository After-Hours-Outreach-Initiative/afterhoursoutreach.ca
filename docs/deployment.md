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

The pre-production migration history now starts at generated
`0000_database.sql`. A preview database that applied the old history must be
explicitly rebuilt before the next deployment; applying the new baseline over
existing tables fails. Export a backup first, then rebuild only the shared
non-production database identified by `wrangler.preview-migrations.jsonc`.
Rebuilding removes existing accounts, sessions, organizer roles, events, and
migration records. Reapply `pnpm db:migrate:preview` afterward. Seeding and
organizer bootstrap remain separate, explicit operations; no command resets
databases automatically. Never use this process for production data.

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
verified@example.org` for your own verified preview account with a completed application if the
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
`pnpm test:preview` checks preview account behavior and rejection of development
endpoints using a local Worker and test database. See [testing.md](testing.md)
for the Vitest projects and browser-test commands.

Production: `pnpm deploy`. The developer controls when to deploy; there is no
custom pre-deployment gate. Before doing so, replace the placeholder production
D1 ID in `wrangler.jsonc`, apply its migrations, configure the account secrets,
and finish the privacy-policy review. Never point production at the shared
preview database. Builds and tests do not deploy anything. Preview deployments
never deploy production code.
The separate `afterhoursoutreach-ca-staging` Worker and `staging.afterhoursoutreach.ca`
domain were retired after live preview checks; the shared D1 database was retained.

## Medic certification reminders

`src/worker.ts` preserves Astro's fetch handler and adds Cron Triggers from
`wrangler.jsonc`: daily discovery at **16:00 UTC** (08:00 PST / 09:00 PDT), and
delivery/retries at **30 minutes past each hour**. Daily discovery also delivers
one batch. Deploy the built `dist/server/wrangler.json` as usual, not the source
Worker directly. Trigger changes can take up to 15 minutes to propagate.

- Only verified accounts with an active volunteer status, the structured `medic`
  team, a recognized structured certification, and a valid expiry date qualify.
  Legacy free-text certification answers are never inferred. Approval/medic-role
  registration requirements are unchanged.
- Warning: once when the expiry enters the **30-calendar-day** window, including
  the expiry day. Expired: a separate message starting **the following day**.
  All comparisons use `America/Vancouver`, including DST; the certificate remains
  valid through its expiry date. Account links use the configured HTTPS
  `AUTH_BASE_URL`, never a request host.
- Activation/outage catch-up is explicitly bounded: existing certificates within
  the warning window qualify, but expired messages cover only the previous
  **seven calendar dates**. Older expired profiles are not backfilled. A missed
  discovery catches up on the next daily run within these windows.
- Each run sends at most **five** emails, serially paced like event mail, sharing
  the existing **80/day** budget with sign-in/event mail. Unattempted backlog can
  wait while still relevant; budget exhaustion does not start its retry clock.
- Migration `0011_medic_certification_notifications.sql` adds the persistent
  outbox/ledger. A unique `(user_id, expiry, kind)` key, atomic token-owned leases,
  and stable Resend idempotency keys prevent concurrent/replayed sends. Renewing
  to a different date creates a new cycle; never delete ledger rows to retry mail.
- The exact recipient and request are frozen on the first provider attempt.
  Failures (including an ambiguous timeout or a failed post-send database write)
  retry hourly for **less than 23 hours from that attempt**, within Resend's
  24-hour idempotency lifetime. After that, status `expired` requires manual
  delivery investigation; automatic resend is deliberately disabled to prevent
  duplicates. This status means delivery is unresolved, not certificate expiry.
  Renewal, loss of eligibility, a changed recipient, or leaving the applicable
  date window cancels stale mail. Cancelled cycles are not automatically restarted.
  Payloads are cleared on terminal states; logs contain aggregate counts only.
- Monitor the `medic_certification_notifications` aggregate log and failed Cron
  Events, especially pending backlog and expired delivery counts. Inspect only
  status/count fields when diagnosing; do not export recipient/payload fields.

Before production deployment, apply generated migrations to the **actual production
D1** (the checked-in ID is still a placeholder), configure `BETTER_AUTH_SECRET` and
`RESEND_API_KEY`, and verify the Resend sender/domain. No new secrets or services
are needed. Local/dev and `APP_ENV != production` (including branch previews)
skip the job without sending or consuming notifications; automated tests inject a
mock provider against isolated D1. No remote migration, deployment, or real email
is performed by the build or tests.

References: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Astro custom Worker entrypoint](https://docs.astro.build/en/guides/integrations-guide/cloudflare/#changed-custom-entrypoint-api),
[Resend idempotency lifetime](https://resend.com/docs/dashboard/emails/idempotency-keys).
