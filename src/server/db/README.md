# Database and business rules

This directory is the source of truth for the application's persisted business
operations. Edit files here, not generated SQL in `drizzle/`.

## Where rules live

| Source                        | Responsibility                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`                   | Tables, defaults, relationships, checks, and unique indexes.                                                                                                |
| `triggers.sql`                | Atomic database invariants: signup eligibility/capacity, organizer approval, orientation places/completion, visibility, and organizer protection/bootstrap. |
| `events.ts`                   | Event/sign-up queries and workflows, version checks, audit records, and notification creation.                                                              |
| `volunteers.ts`               | Approval, activation, roles, attendance, access-related cancellations, and sensitive-profile auditing.                                                      |
| `profiles.ts`                 | Application validation and transactional profile updates.                                                                                                   |
| `application-drafts.ts`       | Owner-only incomplete application snapshots, optimistic revision checks, and atomic session/submission guards.                                              |
| `access.ts`                   | Verified account context and authorization, rechecked inside writes.                                                                                        |
| `policy.ts`                   | User-facing signup eligibility previews and shared email policy. Previews do not replace atomic database enforcement.                                       |
| `sessions.ts`                 | Ownership-scoped session lookup and second-factor verification markers.                                                                                     |
| `notifications.ts`            | Outbox queries, retry eligibility, delivery leases, and delivery state.                                                                                     |
| `medic-certifications.ts`     | Certification reminder eligibility, renewal-cycle ledger, atomic claims, and bounded retry state.                                                           |
| `submission-notifications.ts` | Fixed-recipient review-entry ledger, transactional intents, production claims and shared budget reservations; Preview/legacy suppression.                   |
| `rate-limits.ts`              | Persistent request/email counters and cleanup.                                                                                                              |
| `errors.ts`                   | Safe translation of database invariant errors into application errors.                                                                                      |
| `index.ts`, `sql.ts`          | Request-scoped Drizzle connection and shared SQL clock.                                                                                                     |

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

An application is complete after form submission, Naloxone 101 confirmation,
and application approval. Discord linking is temporarily disabled; its recorded
requirements and milestones are retained. `discord_requirement` is
inserted atomically only for profiles submitted after migration 0020; existing
profiles are not backfilled and retain access without linking. `discord_link`
is both the unique identity mapping and a durable, versioned role-sync outbox.
Eligibility triggers enqueue changes in the same transaction as website writes.
See the [Discord operations guide](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/docs/src/content/docs/discord.md).
Orientation signup and attendance are tracked separately;
neither is an application-completion milestone or a substitute for patrol approval.
Organizer volunteer profiles display Applicant, New volunteer, and Outreach Volunteer/Medic
progression, with a compact application tracker and separate orientation status.
Unapproved applications are **Application in progress** until form submission and
Naloxone 101 confirmation are complete, then **Ready for review**. The review
filter and its count include only ready, unrejected applications.
**Approve for patrols** is available after application approval, without requiring
orientation booking or completion. It does not infer attendance. When the same action
is used from a past orientation roster with an explicit event, it also records that
event's attendance in the version-guarded transaction. Both paths retain audit records
and optional access emails, and do not alter the volunteer's active/inactive status.

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

## Patrols that include orientation

Every event is a patrol; `includesOrientation` is an editable setting, not an
exclusive event type. The legacy `event.type` column is retained without a parent
table rebuild: a nullable `event.includes_orientation` override inherits
`type = 'orientation'` when null. Historical orientations, signups and completion
records are unchanged. New events use legacy `type = 'patrol'` and an explicit
override, including recurring occurrences. Application queries expose the effective
`includesOrientation` and temporarily retain a derived `type` for older callers.
`eventSchema` accepts `includesOrientation` (boolean), or the legacy `type` input;
when both are present the explicit orientation setting wins.
`0015_patrol_orientation_capacity.sql` adds only columns and replacement triggers;
apply it before deploying code that reads the new setting.

Total capacity includes everyone. Organizer event settings control
`minMedicSpots` (reserved **medic** places, default two),
`minNewVolunteerSpots` (reserved **new volunteer** places with orientation, default
two), and `maxNewVolunteers` (new volunteer cap with orientation, default four).
These are reservations, not minimum attendance requirements. Limits are whole
numbers from 0–100; zero removes that reservation or disallows new volunteers.
The new volunteer maximum cannot be below its reserved places.
A medic must have `medic` in `profile.teams`, both authoritative organizer
approvals (`registration_approved` and `patrol_approved`). Orientation attendance
is not a role requirement. No extra certification gate is imposed.

Patrols with orientation also apply their saved new volunteer reservation and cap.
Anyone without manual patrol approval,
including someone with recorded orientation attendance or medic team interest,
counts only as a new volunteer. Patrol-approved volunteers are outreach volunteers
or approved medics regardless of attendance. Each person occupies one place.
The same categories drive event counts, public/organizer rosters, volunteer-list
avatars, profile progression, capacity reservations, and Discord Medic eligibility.

After a candidate is added, `total + max(0, minMedicSpots - medics) + outstandingNewVolunteers`
must not exceed capacity; `outstandingNewVolunteers = max(0, minNewVolunteerSpots - newVolunteers)` only when
orientation is included. Extra medics and additional new volunteers share the general
pool, without consuming the other category's outstanding reservations. Cancellations
free the appropriate category. SQLite insert/update triggers enforce this atomically,
including raw SQL, reactivation, reassignment and organizer moves (failed moves roll
back cancellation, audits and notifications).

`0025_new_volunteer_terminology.sql` renames the internal reservation aliases to
`new_volunteers`; eligibility rules and existing records are unchanged.
`0026_manual_volunteer_progression.sql` switches category and booking-limit triggers
to manual patrol approval and removes attendance-driven Discord sync triggers.
It preserves all existing profiles, approvals, attendance and signups.

New or edited events, series and templates need positive capacity covering all
reserved places (two, or four with orientation, at the defaults).
`0027_event_volunteer_limits.sql` adds defaulted limit columns to events, series
and templates and replaces the enforcing triggers without rebuilding tables.
Existing settings and bookings are not rewritten or
deleted, remain readable/cancellable, and must be corrected before new bookings or
relevant edits. Invalid recurring defaults do not generate new occurrences.

`0016_orientation_minimum_capacity.sql` adds insert/relevant-edit guards without
rewriting historical one-place orientations, bookings, completion records, series
or templates. Existing snapshots stay readable and cancellable. Legacy invalid
recurring defaults do not generate new occurrences until corrected by an organizer;
coverage maintenance itself does not change those defaults.

Insert, reassignment/move and reactivation triggers enforce these limits inside
the write. Orientation/capacity edits reject incompatible existing bookings,
including removing orientation needed by a volunteer without patrol approval,
and cannot remove recorded completion history. Bulk edits roll back their
templates, versions, audits and notifications too. Existing historical excess
bookings are not removed; completion/status changes never silently cancel spots.
Approval and completion remain independent, and all existing access, visibility,
session and application-readiness checks still apply.

Event lists and public rosters restrict volunteers without patrol approval to
events that include orientation, including legacy and recurring events. This is
enforced in both queries, not by browser filters or supplied event IDs. Organizers
and patrol-approved volunteers retain full event visibility under the existing
open/hidden/time-window rules, even without recorded orientation attendance.

`listEvents` includes effective `includesOrientation`, `newVolunteerConfirmed`
(confirmed volunteers awaiting patrol approval), `medicConfirmed` (manually approved
medics), `medicEligible` (the viewer's medic eligibility),
`orientationCompleted` (attendance history only), and category-aware `availableSpots`.
`signupBlockReason` accepts the manual approval and category counts and explains full categories or
reserved places. Availability is capacity-only; the eligibility/booking-limit
reason must still be checked. Both counts and viewer status participate in the
existing view-version polling. `listPublicRosters` separately authorizes approved
event access and rechecks volunteer visibility per event in SQL; its projection is
only event ID, abbreviated name, mutually exclusive category and a display-only
`medicMark` for application-approved volunteers who selected the medic team. New
volunteers can show the plus while remaining in the new-volunteer capacity category;
the marker never contributes to `medicConfirmed`, eligibility or reserved medic places.
An opaque membership digest catches attendee swaps without exposing identifiers.
Public names/categories, medic markers
and that digest participate in `/events` polling; organizer-only full rosters never
enter the volunteer view. Structured first/last names take precedence, with an
abbreviated legacy fallback. No private profile answers or profile links are rendered.

## First-orientation booking limit

Application-approved volunteers without current `patrol_approved` status may hold
one confirmed upcoming orientation booking at a time. Account age and recorded
attendance do not determine who is new. Only explicit manual patrol approval lifts
this cap; orientation completion alone neither advances progression nor lifts it.
The organizer's combined roster approval action explicitly records both milestones.
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
  updates its base defaults/end date, including local time and interval (1–52
  weeks). Existing snapshots are not rewritten, even if now off-cadence; the new
  interval stays anchored to the fixed first date. Effective this-and-future
  templates continue to override base defaults, including local time. Time,
  interval and end-date changes invalidate generation coverage atomically.
  Booked occurrences pushed beyond the signup window remain visible/cancellable
  to their volunteers, without admitting new registrations outside that window.
  End dates are inclusive; shortening atomically cancels affected future snapshots
  and bookings, including individual exceptions. Extending never restores them.
- `updatePatrolSeriesFrom(db, actor, seriesId, nominalDate, template, version,
notify?)` provides actual **this-and-future** editing, including already-generated
  occurrences. The template contains `localTime`, `dayOffset` (−366…366 relative to
  each nominal date), meeting point/link, capacity, open and hidden. The effective
  template applies during generation too. Both series defaults and effective
  templates include `includesOrientation` and all three volunteer limits, copied
  to every new snapshot. Older API clients omitting limits retain saved values on
  edits; new records use the defaults. Bulk edits change only selected fields;
  individual overrides use the same setting through `saveEvent`. An earlier edit
  replaces later templates,
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

The first date and time zone remain immutable. Time/interval settings affect only
newly generated future snapshots; use this-and-future edits to change existing
snapshots. Existing off-cadence dates remain valid boundaries for those edits and
stops. No schedule edit re-keys occurrences. All series mutations recheck
the live organizer session and version inside a D1 batch. Notification creation
requires explicit consent and uses only affected booked occurrences. Retrying
recognizes both `event_audit` and `patrol_series_audit` operation IDs and does not
repeat a mutation. `0014_patrol_submission_integration.sql` adds the recurrence
tables, `patrol_series.stopped_from`, occurrence columns, and submission ledger.
Apply it before running this build; historical standalone records are retained.

First-submission intents are appended using `saveProfile`'s guarded transaction
hook. Immediate `waitUntil` delivery and the existing hourly cron drain only that
outbox. Production uses the shared 80-email UTC-day budget; local simulation uses
none. Preview intents have no payload and cannot be promoted into production mail.
Retries freeze each recipient/request/key and stop after 23 hours from the first
attempt. Unattempted records survive outages; unresolved expired records remain
for human follow-up, without an automatic replacement send.

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
