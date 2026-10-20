# Database and business rules

This directory is the source of truth for the application's persisted business
operations. Edit files here, not generated SQL in `drizzle/`.

## Where rules live

| Source                    | Responsibility                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`               | Tables, defaults, relationships, checks, and unique indexes.                                                                                          |
| `triggers.sql`            | Atomic database invariants: signup eligibility/capacity, organizer approval, orientation event types, visibility, and organizer protection/bootstrap. |
| `events.ts`               | Event/sign-up queries and workflows, version checks, audit records, and notification creation.                                                        |
| `volunteers.ts`           | Approval, activation, roles, attendance, access-related cancellations, and sensitive-profile auditing.                                                |
| `profiles.ts`             | Application validation and transactional profile updates.                                                                                             |
| `application-drafts.ts`   | Owner-only incomplete application snapshots, optimistic revision checks, and atomic session/submission guards.                                        |
| `access.ts`               | Verified account context and authorization, rechecked inside writes.                                                                                  |
| `policy.ts`               | User-facing signup eligibility previews and shared email policy. Previews do not replace atomic database enforcement.                                 |
| `sessions.ts`             | Ownership-scoped session lookup and second-factor verification markers.                                                                               |
| `notifications.ts`        | Outbox queries, retry eligibility, delivery leases, and delivery state.                                                                               |
| `medic-certifications.ts` | Certification reminder eligibility, renewal-cycle ledger, atomic claims, and bounded retry state.                                                     |
| `rate-limits.ts`          | Persistent request/email counters and cleanup.                                                                                                        |
| `errors.ts`               | Safe translation of database invariant errors into application errors.                                                                                |
| `index.ts`, `sql.ts`      | Request-scoped Drizzle connection and shared SQL clock.                                                                                               |

HTTP request parsing and responses remain in `src/pages/api/v1/`. Better Auth's
integration remains in `src/server/auth/`. Email transport and delivery orchestration
remain in `src/server/events/notifications.ts` and `src/server/medic-certifications.ts`; they call the database operations
here instead of issuing their own SQL. Development fixtures are separate in
`src/dev/` and `scripts/`.

## Application storage compatibility

Volunteer application terminology does not rename deployed storage:

- `profile.registered_at` is the application submission time.
- `volunteer_status.registration_approved` stores application approval; query
  aliases and account context expose it as `applicationApproved`.
- `applicationSubmitted` / `hasApplied()` mean a saved profile exists, not approval.
- Historical migrations, snapshots, and trigger definitions keep their original
  names/text, including `0002_registration_approval.sql`. No schema change is needed.
- New approval audit entries use `applicationApproved`. Existing `registrationApproved`
  audit field names and queued notification text remain historical records; they are
  not rewritten. Event registration records describe event spots, not applications.

`profile.preferred_name` historically stored a combined full-or-preferred-name
answer. The name-component migration adds nullable `first_name`, `middle_names`,
and `last_name`, without modifying existing answers. New applications require
first and last names; `preferred_name` may be empty. Profile saves synchronize
`user.name` to the preferred name or assembled full name in the same transaction.
Legacy profiles may retain their unsplit answer until the volunteer supplies both
first and last names. No names are inferred or backfilled.

Referral multi-selects use nullable `heard_about_us_sources` (JSON) and
`heard_about_us_other` (short text) columns. The original `heard_about_us`
free-text answer is kept unchanged; null choices on legacy profiles are not
inferred or backfilled. New applications require at least one choice and a
nonblank detail of at most 200 characters for Other; unselected Other text is
ignored. All referral columns are insert-only in profile saves, so account
edits preserve both legacy and structured answers exactly.

## Application drafts

`application_draft` stores one private, versioned JSON draft per account. Draft
validation bounds types and sizes but allows incomplete or invalid answers; it
never records Code of Conduct acceptance, creates a profile/status, updates the
account name, or queues notifications. The API derives ownership from the session
and checks the client's expected user ID to protect stale tabs after account
switching. Each write atomically checks session access, the prior revision, and
the absence of a submitted profile. Profile submission deletes the draft in the
same D1 batch; late autosaves cannot recreate it. User deletion cascades to drafts.

## First-orientation booking limit

Application-approved volunteers with neither an `orientation_completion` record
nor current `patrol_approved` status may hold one confirmed upcoming orientation
booking at a time. Approval dates do not determine who is new: older accounts
without either status follow the same rule. A recorded completion or explicit
patrol approval lifts this cap; completion still does not grant patrol approval.
Organizer role alone does not lift the cap (or grant patrol approval).

Confirmed bookings for future, non-cancelled orientations count even when an
event is closed or hidden. Cancelled signups, cancelled events, and events that
have started do not count, so cancellation/rebooking and rebooking after a missed
orientation are allowed. The insert/update triggers check the limit inside the
write, including reactivation and organizer moves, not in a race-prone preflight.
The migration does not change existing bookings. Accounts already above the cap
keep those spots but cannot add another until none count or the cap is lifted.
No over-cap cleanup runs on event edits or status changes; existing access-revocation
and event-cancellation workflows are unchanged.

## Recurring patrol controls

`patrol-series.ts` owns recurrence; its public operations are re-exported by
`events.ts`. A nominal `(series_id, occurrence_date)` and its deterministic event
ID never change, even when the actual start date/time changes. Volunteers can
register only for the earliest three future, non-cancelled occurrences per series;
hidden, closed, and full occurrences consume slots. Reads and version polling
await generation, and SQL signup guards fail closed beyond its coverage frontier.

- `savePatrolSeries(db, actor, input, id?, version?, notify?)` creates a series or
  updates its base defaults/end date. Existing snapshots are not rewritten.
  End dates are inclusive; shortening atomically cancels affected future snapshots
  and bookings, including individual exceptions. Extending never restores them.
- `updatePatrolSeriesFrom(db, actor, seriesId, nominalDate, template, version,
notify?)` provides actual **this-and-future** editing, including already-generated
  occurrences. The template contains `localTime`, `dayOffset` (−366…366 relative to
  each nominal date), meeting point/link, capacity, open and hidden. The effective
  template applies during generation too. An earlier edit replaces later templates,
  but preserves earlier templates, individual `saveEvent` exceptions, cancellation
  tombstones, past occurrences, event IDs, and every booking row. Capacity failures
  roll back the entire operation. Any `event_audit` action `updated` marks a permanent
  individual exception; series updates use `series_updated`, not `updated`.
- `stopPatrolSeries(db, actor, seriesId, nominalDate, version, reason?, notify?)`
  permanently stops generation from that date (exclusive boundary). It cancels
  existing future occurrences and bookings at/after it, including exceptions, but
  keeps past history. End-date extension cannot restart a stopped series.
- `materializePatrolOccurrence` lets organizers select any scheduled date beyond
  the volunteer window. Existing past/cancelled snapshots remain addressable even
  after shortening/stopping. It never restores a cancellation. Organizer listings
  accept an optional selected occurrence ID so the 100-row limit cannot hide it.

The first date and interval remain the immutable nominal cadence. Change cadence
by stopping the old series and creating another; change actual day/time using
effective templates, not by re-keying occurrences. All series mutations recheck
the live organizer session and version inside a D1 batch. Notification creation
requires explicit consent and uses only affected booked occurrences. Retrying
recognizes both `event_audit` and `patrol_series_audit` operation IDs and does not
repeat a mutation. `patrol_series_template` and `patrol_series.stopped_from` require
ordered migration generation by the integration owner before deployment.

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
