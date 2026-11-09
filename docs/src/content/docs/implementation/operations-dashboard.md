---
title: Dashboard administration
description: Use the local operations dashboard to administer D1 application data and monitor delivery, usage, and Resend limits.
---

Open the [Operations dashboard](/dashboard/) in the local documentation site.
This is a privileged local tool for **remote D1 databases**, not the app's local
SQLite database. Ordinary documentation remains usable without credentials.

## Setup

From the repository root:

```sh
pnpm exec wrangler login
pnpm docs:dev
```

Visit [http://127.0.0.1:4322/dashboard/](http://127.0.0.1:4322/dashboard/).
The dashboard reuses the project's installed Wrangler and its existing login
or environment credentials. It never displays those credentials in the browser.
The Cloudflare account defaults to `account_id` in `wrangler.jsonc`.

For narrowly scoped automation credentials, D1 discovery/inspection requires
**D1 Read**; mutations require **D1 Write** (or the corresponding current D1
product role). D1 analytics additionally needs **Account Analytics Read**. If
analytics permission is missing, the other sections remain usable. Never paste
credential values into chat, source files or a SQL command.

The selector discovers databases in the configured account. To use another
account accessible to your credentials, set `DOCS_DASHBOARD_ACCOUNT_ID` in
`docs/.env.local`, restart the docs server, then reconnect. This setting changes
only the dashboard, not application bindings or deployments.

## Resend limits

Copy `docs/.env.example` to **`docs/.env.local`**, then enter your dedicated
full-access Resend key as `DOCS_DASHBOARD_RESEND_API_KEY`. The file is Git-ignored
and blocked from Vite's filesystem server. Do not prefix the variable with
`PUBLIC_`, reuse the application's send-only key, or commit the value.

The Email and jobs section reads Resend's documented `GET /usage` endpoint to
show daily/monthly email quota, contacts, domains and API rate limits. Results
are cached for one minute. The dashboard reloads this variable when reading
usage, so adding a key needs only a refresh; after replacing a configured key,
wait for the one-minute cache or restart the docs server.

Limits apply to the **whole Resend account/team**, not the selected D1 database.
Unlimited quotas are displayed as “No cap”; reset dates come from Resend. The
full-access key stays server-side. Despite its provider permissions, this
dashboard exposes **no sending, retrying, key-management or Resend write API**.

## Database selection and write protection

- Only IDs in the same-account `wrangler.preview-migrations.jsonc` preview
  configuration are classified as preview. Names such as “test” or “staging”
  alone never bypass protection.
- Production and every unclassified database start **read-only**. Type its exact
  name to unlock writes for ten minutes in the current local browser session.
  **Lock now** immediately clears that session's pending reviews and unlock.
- Every mutation, including preview changes, has a separate review showing the
  exact database name/ID, target, consequences and applicable blockers.
- Deletion and event cancellation require typed confirmation. Reviews expire
  after two minutes, are single-use and are tied to the session and database.
  Changing database closes the context; switching to a different target cannot
  execute an old review there.
- The server reloads the target and checks its version and deletion impact
  before applying a parameterized D1 transaction. Concurrent application edits
  can refuse the change; refresh and review again rather than forcing it.
- Only dedicated operations are accepted. There is no arbitrary SQL console,
  arbitrary row editing, schema migration, export, restore or reset control.

The preview configuration can change over time. Always read the displayed
account, database name and UUID before applying a change. The dashboard does
not connect production to the Worker, migrate databases or deploy anything.

## Users and approvals

Search by name/email and filter awaiting approval, organizers or inactive users.
Each account exposes reviewed controls for:

- application and patrol approvals;
- organizer/volunteer role changes;
- deactivation/reactivation;
- revoking all sign-in sessions;
- permanent deletion with an affected-record summary.

New organizers need verified email and a submitted, active, approved application.
This also allows first-organizer provisioning after those steps, without
creating a fake app login. The last usable organizer cannot be demoted,
deactivated or deleted. Patrol approvals and orientation completions reference
an existing active organizer, while the dashboard's local activity log records
the administrative operation under the local OS operator. This is a privileged
out-of-band operation, not a claim that the referenced organizer signed in.

Deactivation signs the user out and cancels future registrations. Revoking
application approval cancels future bookings for volunteers; organizer access
retains the application's organizer exception. Revoking patrol approval cancels
future non-orientation bookings. Neither reactivation nor reapproval restores
cancelled registrations automatically.

**Dashboard actions do not send notification emails.** Review affected bookings
and arrange any necessary communication yourself.

### Permanent deletion

Prefer deactivation when historical records should remain. Permanent deletion
removes owned application/profile, session/auth, registration, completion,
delivery-ledger and subject-audit records shown in the review. Foreign-key
constraints remain enabled. Authored events/series, approvals of other users,
marks/audits on other people's records and unknown dependencies **block deletion**
instead of being reassigned, silently erased or bypassed.

Deletion is not a complete privacy-erasure workflow: frozen event-email batch
payloads, provider emails, short-lived verification records, backups and local
administrative activity can persist. Handle those under the project's retention
and privacy procedures. No provider API is called to erase external history.

## Events and registrations

The dashboard lists up to 60 occurrences (upcoming first, then recent history)
and up to 50 recurring series. Inspect rosters and category/capacity counts;
change an upcoming occurrence's registration state, visibility or capacity;
cancel an event; remove a registration; or mark a registered attendee's
orientation completed after the event starts.

Capacity edits remain subject to the database's reservations for medics and new volunteers,
total-capacity and existing-registration guards. Hiding/closing an event does
not cancel bookings. Cancelling an event does; recurring cancellation tombstones
remain permanent. Actions affect **only the selected occurrence**, not future
series defaults. Use the application's organizer interface for creating events,
changing recurring schedules or this-and-future edits.

## Monitoring

- **Overview:** users, active users, approvals, organizers, upcoming events and
  confirmed upcoming registrations.
- **Email and jobs:** bounded status/attempt/lease metadata from event,
  application-submission and medic-reminder delivery ledgers; no message bodies,
  frozen payloads or credentials are returned. “Sent” means provider acceptance,
  not inbox delivery. A queue snapshot does not prove the Worker cron is running.
- **Database health:** provider metadata, schema compatibility and seven UTC
  dates of D1 read/write queries, rows read/written and p90 query latency when
  available. These are not an integrity check or backup. Metrics can lag.
- **Activity:** latest 100 local entries for the chosen database. The full local
  log is at `.wrangler/docs-dashboard/activity.jsonl`, Git-ignored and mode 0600.

Unsupported D1 schemas can still be selected for metadata, schema and usage
inspection. Application-specific controls are disabled; there is no attempt to
guess user tables or mutate unrelated applications.

Refresh is manual by default. Optional one-minute refresh pauses while the tab
is hidden, a review is open, or a form control has focus. Resend/D1 usage reads
are cached for a minute. Dashboard reads contribute to D1 usage.

## Safety and operational limits

The privileged endpoints are registered only by Astro's **development-server
integration**. Builds and `astro preview` have no dashboard API. Requests require
a loopback socket/host, the matching local server port and same-origin browser
context. Mutations additionally require an exact Origin, a strict HttpOnly
session cookie and a session-specific CSRF header. The page refuses framing;
logs and secret files are denied by Vite's filesystem endpoint.

Do not expose this server through a tunnel, reverse proxy, port-forward to other
people, LAN binding or public hosting. Anyone trusted to use this local browser
or the host's credentials is an administrator. Local sessions expire after
30 minutes without API activity or eight hours total; restarts forget all
sessions/unlocks/reviews. Close the dashboard or stop the server when finished.

Mutations record intent locally **before** contacting D1, then success/failure.
If the audit file is not writable, no mutation is submitted. Logs contain
operation IDs, record IDs, target database, OS username and error codes, not
SQL, emails, application answers, auth tokens or provider responses. This is
local operational history, not a tamper-proof or centralized audit trail.

Network errors can leave an **unknown** outcome: D1 may have committed even if
the response was lost. There are no automatic mutation retries. Refresh the
target and inspect state before reviewing a new action. An unmatched “started”
log after a process crash has the same meaning. Check disk space and retain or
rotate the local log under your own retention policy.

No dashboard-specific tests should be written or run; the repository's
`AGENTS.md` prohibits tests for `docs/`. Use `pnpm docs:check` for static diagnostics.
