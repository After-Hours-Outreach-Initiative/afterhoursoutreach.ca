# Backend

The server side behind accounts, registration, and event signups.

## Stack

- `@astrojs/cloudflare` adapter. Account and event related pages under
  `/volunteer` will render on the server, while everything else can be static.
- Cloudflare D1 for the database.
- Drizzle for the schema and migrations.
- Better Auth with the official Email OTP plugin for sign in and sessions. See
  [accounts.md](accounts.md).
- Resend for sign in and notification emails.

## Local testing

Apply `pnpm db:migrate:local`, configure a local `BETTER_AUTH_SECRET` of at least
32 characters in `.dev.vars`, then start `pnpm dev --background`. No extra
frontend mode is needed. Dev, production builds, and Worker previews use the same components and
account/event backend. D1 persists under `.wrangler/state/`; remote bindings
are disabled. A Resend key is not required locally. Sign-in links and codes
appear in a dialog, not an inbox. Local D1 rate limits still apply.

On localhost or the dev server's LAN address, the shared account layout includes
a **View as** selector populated from all users in local D1, including accounts that have
not finished registration. Choosing a user replaces only this browser's
session; choosing Visitor signs out. Switching simulates a verified two-factor
session for users with an enrolled authenticator, without changing their role,
email verification, active status, profile, or patrol approval. Create new
accounts through the regular sign-in form.

Run `pnpm db:seed:local` with the dev server running to restore local test data:
an orientation, an open patrol, a full patrol, a hidden/closed orientation, and
a past orientation with attendance. Sample users are stored in D1 too; choose
**Robin Vance** in View as for event and volunteer-management tools. Robin’s
authenticator is enrolled through the real local auth backend. The command
only targets local D1, preserves existing records and fixture edits, and never
runs during a build or deployment. Dev UI has no privacy disclosures; storage
details belong on `/privacy`.

The selector and its `/api/auth/dev/*` endpoints require a development build.
Local auth uses the current request's origin so phones on
the LAN can also switch accounts. POSTs require the same Origin as the website.
These controls and simulated email dialogs are excluded
from public builds. Worker previews still use preview D1 and real,
rate-limited email delivery. Accounts and events are always included in production
builds; deployment readiness is controlled by the developer, not a feature flag.

## Organizer access

Outside the explicit local fixtures, the first organizer must sign in and finish
registration. A developer then runs one of:

```sh
pnpm organizer:bootstrap --local --email verified@example.org
pnpm organizer:bootstrap --preview --email verified@example.org
```

This is a one-time, audited D1 transaction. It ends the account's sessions;
sign in again. It cannot target production. No organizer
is promoted automatically or based on the email address supplied to a web form.

Organizers manage active status, patrol approval, and roles at
`/volunteer/volunteers`. Promotions require an active, registered account with
a verified email. Role changes revoke
the target's sessions. The last active organizer cannot be demoted/deactivated.
Two-factor authentication is optional for organizers and volunteers; accounts
that enable it must complete it when signing in. Full profile
views are logged atomically before answers are returned; lists/rosters contain
names, not sensitive answers.

## Events

`/volunteer` is request-rendered and lists D1 events, never invented fixtures.
Organizers create/edit events, separately close signups or hide listings, view
rosters, move/remove signups with an optional emailed reason, and mark past
orientation attendance. Volunteers can sign up and cancel before the event
starts. D1 triggers enforce eligibility and capacity across concurrent requests.
Edits use version checks to prevent overwriting another organizer's changes.

Event cancellation requires creating another event to reschedule, not a
permanent deletion: it retains the event and cancelled signup records. Hiding
or closing an event preserves existing spots; signed-up volunteers can still
see a hidden event. Access revocation cancels affected future signups.
Orientation completion never grants patrol approval.

Notification records are written in the same transaction as the change.
Delivery failure leaves the change saved and the notification pending. Public
requests attempt at most five notifications to keep Worker subrequests bounded;
organizers can retry pending notifications from `/volunteer`. There is no
scheduled dispatcher yet. Resend idempotency keys plus D1 leases protect
against concurrent duplicate sends. The original sending origin is frozen so
retries on branches sharing preview D1 keep the same provider payload.
Retries stop 23 hours after
creation; older pending records require manual follow-up, not a blind resend.
Sign-in and notification sends share the 80/day budget. Local D1 delivery never
contacts Resend; DEV-only dialogs simulate notification success/failure.

Before deploying production, complete the privacy review, approved retention and
deletion safeguards, and production D1 provisioning. These are launch requirements,
not application feature gates. Email changes and account deletion are not
implemented. Use sample profile answers in public tests.

## Hosting

The same `afterhoursoutreach-ca` Worker, with a D1 binding in `wrangler.jsonc`.
The Resend API key is a Worker secret.

Everything runs on the Workers free plan:

- 100,000 requests a day.
- 10ms of CPU per request. Sign in has no password hashing, so this is enough,
  but a request that goes over fails with error 1102.
- D1: 5 million rows read and 100,000 rows written a day, and 5 GB of storage.

The paid plan ($5/month) raises all of these if we ever hit them.

D1 has no Canadian region, so the data is stored in the US. The privacy page
has to say so. See [privacy.md](privacy.md).

## Email

Sent through Resend's API from `noreply@afterhoursoutreach.ca` (TODO: Resend
recommends
[not using no-reply](https://resend.com/docs/dashboard/emails/deliverability-insights#don%E2%80%99t-use-%E2%80%9Cno-reply%E2%80%9D)).
Emails include "Questions? Ask us on Discord" and a link to the Discord server.

The Resend free plan allows 3,000 emails a month and 100 a day. The sign in
rate limit in [accounts.md](accounts.md) also protects this quota.

## TODO

- TODO: decide on database backups. D1 Time Travel covers 7 days on the free
  plan. Decide if we also want periodic exports, and where those would be
  stored safely given what is in them.
