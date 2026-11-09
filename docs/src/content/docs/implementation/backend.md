---
title: Backend
description: Server stack, database ownership, and generated migration workflows.
---

The server side behind accounts, applications, and event signups.

## Stack

- `@astrojs/cloudflare` adapter. The application at `/apply` and account/event
  pages under `/volunteer` render on the server; public content can be static.
- Cloudflare D1 for the database.
- Drizzle for the schema and migrations.
- Better Auth with the official Email OTP plugin for sign in and sessions. See
  [Accounts specification](/specification/accounts/).
- Resend for sign in and notification emails.

All HTTP API endpoints use `/api/v1/`, including authentication and health checks.
The unversioned routes are no longer served. This keeps event requests outside the
`workers.dev/api/event` adblock rule.

## Database and business rules

Database queries and persisted business workflows are grouped in
[`src/server/db/`](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/db/README.md). Constraints are declared in
`schema.ts`, atomic invariants in `triggers.sql`, and workflows in the event,
volunteer, profile, access, session, outbox, and rate-limit modules there.
HTTP handling, authentication integration, and email transport stay outside.

Run `pnpm db:generate` after changing schema or trigger definitions. Everything
in `drizzle/` is generated and committed; do not edit it. `pnpm db:check` and
the tests detect stale or hand-edited SQL output.

After generating a migration, run `pnpm db:migrate:local` so the development
database matches the code. Remote migrations are separate deployment operations.

The pre-production migration history was consolidated into generated
`0000_database.sql`. Old-history local/preview databases require an explicit
rebuild before applying this baseline; generation never resets a database.

## Development and operations

- [Local development](/implementation/development/) covers local D1, simulated
  delivery, the DEV panel, and sample accounts.
- [Accounts and authentication](/implementation/accounts/) covers sign-in,
  application persistence, compatibility, and organizer provisioning.
- [Events and registrations](/implementation/events/) covers refresh,
  authorization, concurrency, and visibility compatibility.
- [Notification delivery](/implementation/notifications/) covers outboxes,
  provider transport, retries, and scheduled reminders.
- [Deployment](/implementation/deployment/) covers production and previews.
- [Privacy implementation review](/implementation/privacy/) records the data and
  access review; [Privacy planning](/planning/privacy/) holds proposed practices.
