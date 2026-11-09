---
title: Local development
description: Run the application locally, simulate integrations, and use reusable development accounts.
---

Use these tools to exercise the [account](/specification/accounts/) and
[event](/specification/events/) workflows with local data.

## Run the application

Apply `pnpm db:migrate:local`, configure a local `BETTER_AUTH_SECRET` of at least
32 characters in `.dev.vars`, then start `pnpm dev`. No extra
frontend mode is needed. Dev, production builds, and Worker previews use the same components and
account/event backend. D1 persists under `.wrangler/state/`; remote bindings
are disabled. A Resend key is not required locally. Sign-in links and codes
appear in a dialog, not an inbox. Local D1 rate limits still apply.

Automated browser tests use `pnpm test:ui`, which starts its own server and
disposable D1 database; it never adds test accounts to this persistent dev database.
See [Testing guide](/implementation/testing/).

On localhost or the dev server's LAN address, the shared account layout includes
a **DEV panel** button. Press **Alt+Z** to open or close it. **Account states** holds
Visitor and reusable test scenarios; **Existing accounts** lists saved local users,
including unfinished applications and older seeded presets. Choosing a saved
user replaces only this browser's
session; choosing Visitor signs out. Switching simulates a verified two-factor
session for users with an enrolled authenticator, without changing their role,
email verification, active status, profile, or patrol approval. Create new
accounts through the regular sign-in form.

**Account states** reuses one temporary sandbox identity per browser, identified
by a signed HttpOnly development cookie. Choosing **Draft application** always
resets it to a sample draft, even after completing all application steps. **Not
applied** resets it to an empty application. The other buttons similarly restore
their named milestones, access, and attendance. Progress remains usable while
testing but is discarded on the next state selection; clicks do not create a new
account each time or add the sandbox to Existing accounts. Browsers have separate
sandboxes. Switching to a saved account or Visitor does not reset saved work.

Resets are atomic and limited to the marked temporary identity. They revoke its
old sessions and rotate the draft generation so old browser backups cannot restore
discarded test answers. A fixed internal sample organizer supports patrol approvals
and attendance; it is not listed as a saved account. Sample orientation events are
reused too, and refuse to reset if that would affect another volunteer's booking
or attendance. A real Discord link must be handled before resetting the sandbox;
the reset never drops its role-removal obligations. These are actual local D1
records needed to exercise the normal backend, not a frontend-only mock.

Older manual presets have no trash button, and the server rejects their deletion without
changing any records. Protection uses only their exact preset IDs, even if renamed.
Other saved local accounts retain the compact trash button on the right. Click
it once to show a confirmation checkmark, then click again to delete. Clicking
away, pressing Escape, or closing the panel clears the confirmation. This includes
regular sign-in accounts, other named fixtures, and the
original Not applied account. Visitor and the virtual Not applied choice have no
trash button; deleting the current account signs out, while deleting another
leaves the current session alone. Deletion removes its application, draft,
sessions, and related volunteer
records in one transaction. Existing database protections block deletion of the
last active organizer and accounts referenced by organizer-owned records; an error
is shown and no records are changed when deletion is blocked.

**Application steps** has four shortcuts for the signed-in account: submit a
sample application, complete Naloxone 101, simulate a Discord connection, and
approve the application. The simulated link uses a fictional `local-only` server
with no token or Discord API call; it cannot be processed by the real sync job. Each
button enables after its prerequisite and shows Completed afterward. Step 1 uses
fictional seed answers and normal submission validation, never replaces an
existing submission, and clears its draft. The shortcuts send no email and do
not grant organizer or patrol approval. They update actual local records, not a
visual override; choose Draft application or Not applied to reset the temporary
sandbox and begin again. Saved accounts are never reset by these buttons.
Signed-out requests, cross-origin requests, and requests for a different account
are rejected. These endpoints are absent from deployed builds.

State buttons work without seeding. To add persistent sample accounts and events,
click **Seed local accounts** in the DEV panel or run
`pnpm db:seed:local` with the dev server running and local migrations applied.
The button refreshes the panel in place without switching your account or
changing its session. It uses the same fixtures as the command, enrolls the
Organizer authenticator through the normal auth backend in an isolated temporary
session, and sends no emails. **Visitor** signs out; the remaining choices are grouped:

- **Application:** Not applied (always empty), Draft application (sample draft, not
  submitted), Form submitted (Naloxone incomplete), Awaiting review (Naloxone
  complete, application unapproved).
- **Orientation:** Ready for orientation, Orientation booked, Orientation completed
  (not yet patrol approved), Medic awaiting orientation.
- **Active volunteers:** Patrol volunteer and Medic. Both have completed
  applications, recorded orientation attendance and organizer-granted patrol
  approval. Medic also has the medic team and a valid fictional certification;
  selecting the team alone does not qualify for reserved medic places.
- **Access:** Inactive (completed application, inactive account) and Organizer
  (active organizer with application and patrol approval). The older seeded
  Organizer account additionally has an enrolled authenticator.

All categories stay expanded. State buttons describe their reset points, while
Existing accounts shows each saved account's actual progress and eligibility.
The original Applied and Accepted IDs remain stable in Existing accounts, with
the new Form submitted and Ready for orientation labels. Preset definitions,
ordering, categories and deletion protection share `src/dev/accounts.ts`.

Submitted profiles use realistic fictional answers, immutable application
snapshots, Code of Conduct acknowledgement, and milestone dates. Submitted sample
personas model existing volunteers exempt from Discord linking, rather than
inventing real OAuth consent. Temporary states use the new four-step flow with
simulated Discord membership, never real OAuth credentials.
See [Discord](/implementation/discord/) for configuration and isolation. The command
also adds an open patrol with orientation, an open regular patrol, and a hidden
past orientation with attendance. It does not reset the database, remove users,
restore cancelled bookings or discarded drafts, or overwrite subsequent edits.
Reseeding repairs missing Naloxone/application-approval milestones only for
unchanged original Accepted, Inactive and Organizer fixtures, checked against
their original identity, answers, timestamps, access flags and absence of activity.
Their original snapshots and authenticators are retained.
The original Not applied fixture is preserved separately as **Original Not applied
account** (or its submitted name if already completed); its application/draft is
never reset when choosing the reusable Not applied option.

This is the only manual seed command. Automated browser tests use their broader
event, signup, and attendance fixtures only in their own disposable database;
you do not need to seed those manually. Existing accounts and events from older
seed commands remain untouched. The manual seed only targets local D1 and never
runs during a build or deployment. Dev UI has no privacy disclosures; storage
details belong on `/privacy`.

The profile buttons and their `/api/v1/auth/dev/*` endpoints require a development build.
Local auth uses the current request's origin so phones on
the LAN can also switch accounts. POSTs require the same Origin as the website.
These controls and simulated email dialogs are excluded
from public builds. Worker previews still use preview D1 and real,
rate-limited email delivery. Accounts and events are always included in production
builds; deployment readiness is controlled by the developer, not a feature flag.

## Excluding development tools from hosted builds

Development-only browser scripts and email-dialog styles live in `src/dev/`,
alongside the server account-switching plugin. Shared application code loads
them through dynamic imports guarded by `import.meta.env.DEV`. The guard is
replaced at build time, so both production and preview builds exclude these
modules. The folder name itself does not exclude code from a build; keep every
runtime import from outside `src/dev/` behind the guard. Type-only imports are
safe because TypeScript removes them.

The development controls are available only in the local dev server. Built
Worker tests check that `GET /api/v1/auth/dev/users`,
`POST /api/v1/auth/dev/switch-user`, `POST /api/v1/auth/dev/delete-user`,
`POST /api/v1/auth/dev/application-step`, and `POST /api/v1/auth/dev/seed-accounts`
return `404` in production and preview builds;
local browser tests exercise account switching, application-step shortcuts, and
simulated email delivery.
Dev-tool assets must not be placed in `public/`, which is copied into builds.
