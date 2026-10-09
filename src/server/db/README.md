# Database and business rules

This directory is the source of truth for the application's persisted business
operations. Edit files here, not generated SQL in `drizzle/`.

## Where rules live

| Source               | Responsibility                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`          | Tables, defaults, relationships, checks, and unique indexes.                                                                                          |
| `triggers.sql`       | Atomic database invariants: signup eligibility/capacity, organizer approval, orientation event types, visibility, and organizer protection/bootstrap. |
| `events.ts`          | Event/sign-up queries and workflows, version checks, audit records, and notification creation.                                                        |
| `volunteers.ts`      | Approval, activation, roles, attendance, access-related cancellations, and sensitive-profile auditing.                                                |
| `profiles.ts`        | Registration validation and transactional profile updates.                                                                                            |
| `access.ts`          | Verified account context and authorization, rechecked inside writes.                                                                                  |
| `policy.ts`          | User-facing signup eligibility previews and shared email policy. Previews do not replace atomic database enforcement.                                 |
| `sessions.ts`        | Ownership-scoped session lookup and second-factor verification markers.                                                                               |
| `notifications.ts`   | Outbox queries, retry eligibility, delivery leases, and delivery state.                                                                               |
| `rate-limits.ts`     | Persistent request/email counters and cleanup.                                                                                                        |
| `errors.ts`          | Safe translation of database invariant errors into application errors.                                                                                |
| `index.ts`, `sql.ts` | Request-scoped Drizzle connection and shared SQL clock.                                                                                               |

HTTP request parsing and responses remain in `src/pages/api/v1/`. Better Auth's
integration remains in `src/server/auth/`. Email transport and delivery orchestration
remain in `src/server/events/notifications.ts`; they call the database operations
here instead of issuing their own SQL. Development fixtures are separate in
`src/dev/` and `scripts/`.

## Generated migrations

```sh
pnpm db:generate --name=describe_change
pnpm db:check
```

`scripts/generate-db.ts` uses the installed Drizzle Kit SQLite generator for schema
diffs and includes the current `triggers.sql` definitions. Drizzle has no SQLite
trigger declaration API, so this small wrapper handles that part explicitly.
Use this command instead of calling `drizzle-kit generate` directly.

- `drizzle/*.sql` and `drizzle/meta/*` are generated, committed artifacts.
- No source change means no new migration and no changes to existing files.
- Source changes generate a new, frozen migration; historical migrations never
  import mutable source files at execution time.
- Previous triggers are dropped before schema changes and current triggers are
  installed afterward. This also preserves them across SQLite table rebuilds.
- D1 uses foreign-key deferral during table rebuilds. Rebuilding a parent with
  cascading or other destructive child relationships is refused rather than
  silently deleting/changing child data; those upgrades need an explicit data
  migration or a fresh non-production database.
- The generator validates the entire migration history in scratch SQLite memory
  before writing output. It never connects to local or remote D1.
- `db:check` detects source drift, edited SQL, and SQL outside the journal. The
  test suite runs the same check and exercises migration generation/upgrades.

Add one `CREATE TRIGGER` statement per `--> statement-breakpoint` section in
`triggers.sql`. Change the current definitions rather than writing `DROP TRIGGER`
or editing historical migrations yourself. Workflow rules that need caller/session
context or auditing stay in the domain modules above; essential cross-row invariants
also remain enforced by the database.

## Pre-production baseline

The old handwritten/mixed migration history has been replaced with generated
`0000_database.sql`. Existing development/preview databases that applied the old
history must be explicitly rebuilt before using this baseline. No database is
reset automatically. Do not apply it over an existing old-history database.

After production data exists, keep the history and only generate incremental
migrations. Regeneration is not permission to delete deployed migration history.
