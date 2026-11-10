---
title: Accounts and authentication
description: Authentication mechanics, application persistence, compatibility, and organizer provisioning.
---

Implements the [Accounts specification](/specification/accounts/). Development
account switching and simulations are covered in [Local development](/implementation/development/).

## Authentication

The sign-in form requests email verification through Better Auth's Email OTP
plugin. Delivery includes a sign-in link and a six-digit code. The code can be
read on another device and entered in the requesting browser. Link completion
requires the browser binding established when the email was requested; opening
the email elsewhere does not transfer that binding.

The link and code use the same single-use verification value. Both expire after
ten minutes; using either consumes it. Three wrong code attempts invalidate the
challenge, and requesting another email replaces the previous code and link.
New verified addresses create accounts and enter the application flow.

Better Auth's official Email OTP plugin generates, stores, expires, and consumes
the code, creates verified accounts, and manages sessions. The link carries that
same code in its URL fragment, not a separate token; fragments are not sent in
HTTP requests. The completion page clears the fragment from browser history.
Only pressing **Confirm sign-in** submits the code, so simply visiting the page
does not consume it, including when a mail scanner runs JavaScript.

The generated database baseline uses Better Auth's verification table, not the
old email-challenge table. See [database migrations](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/db/README.md)
before rebuilding a pre-production database that used the old migration history.

## Application persistence

New applications require `codeOfConductAccepted: true` in the profile API too;
omitted, false, and non-boolean values cannot create a profile. The server saves
the rules version and acknowledgement time with the profile in the same
transaction. Profile edits neither require the checkbox again nor change that
record. Existing and synthetic profiles are not backfilled with invented consent.
The acknowledgement fields are part of the generated database baseline.
Generate migrations from the schema and apply them locally before handoff.

The form definitions live in `src/data/application.ts`. The profile endpoint
remains `/api/v1/account/profile`, since it also handles ongoing profile edits.
Organizer status requests use `applicationApproved`; the old `registrationApproved`
input is accepted for older open forms, but conflicting values are rejected.
See [storage compatibility](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/db/README.md#application-storage-compatibility)
for the unchanged SQL names and historical records. No data migration is needed
for this terminology change.

Profile updates omit application-only questions. The server preserves the saved
referral, motivation, and acknowledgement fields even when older clients submit
values for them.

## Routes and presentation

The application form lives at `/apply`. Application responses use private-page
headers: no caching or indexing. Return URLs accept current account, application,
event, and organizer directory routes.

The Code of Conduct initially shows two rules with a fade. **Read all rules**
expands the list and removes the fade; **Show fewer rules** collapses it. The
required acknowledgement remains visible before **Complete application**.
Profile and application forms use section headings and horizontal dividers.

## Legacy profile compatibility

Earlier changes introduced application approval, separate name components, and
structured referral sources. Their migration history is now consolidated into
the generated baseline; use the current [database workflow](/implementation/backend/#database-and-business-rules)
instead of applying the old numbered migration files.

Legacy combined-name answers remain in `preferred_name`; missing first/middle/last
components are not guessed. Those volunteers may retain their old name while
both first and last names remain blank, or supply both. Once supplied, both are
required. The original free-text `heard_about_us` is kept verbatim; structured
`heard_about_us_sources` JSON and `heard_about_us_other` text are not inferred
from it. Account edits preserve all referral columns, and organizer views show
legacy free text when present.

## Sessions and abuse counters

Sessions are configured for 30 days and renew with use. Their cookies are
HttpOnly, SameSite=Lax, and Secure on HTTPS. Optional authenticator setup uses
TOTP with backup codes; enrolled accounts must complete the second factor at
sign-in.

Better Auth stores hashed codes in its verification table. D1 counters enforce
the following limits in `src/server/db/rate-limits.ts`, with auth configuration
in `src/server/auth/index.ts` and the shared email budget in
`src/server/db/policy.ts`:

| Operation              | Current limit                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Sign-in email request  | 30-second per-address cooldown.                                                          |
| Email-change request   | One-minute per-address cooldown.                                                         |
| Email requests         | Ten per address per hour and ten per IP per hour.                                        |
| Shared delivery budget | 80 emails per day, shared with notification mail.                                        |
| Code verification      | Three attempts per code, ten submissions per address per hour, and 30 per IP per minute. |

The per-address verification budget survives resends and code rotation. These
mechanisms implement the specification's [abuse-protection requirement](/specification/accounts/#abuse-protection).

## Organizer access

Outside the explicit local fixtures, the first organizer must sign in and finish
their application. A developer then runs one of:

```sh
pnpm organizer:bootstrap --local --email verified@example.org
pnpm organizer:bootstrap --preview --email verified@example.org
```

This is a one-time, audited D1 transaction. It ends the account's sessions;
sign in again. It cannot target production. No organizer
is promoted automatically or based on the email address supplied to a web form.

Organizers manage application approval, active status, patrol approval, and roles at
`/volunteers`. Promotions require an active account with
a verified email and approved application. Role changes revoke
the target's sessions. The last active organizer cannot be demoted/deactivated.
Two-factor authentication is optional for organizers and volunteers; accounts
that enable it must complete it when signing in. Full profile
views are logged atomically before answers are returned; lists/rosters contain
names, not sensitive answers.

Account and organizer mutations show loading states and update the affected
server-rendered controls, lists, and delivery counts without reloading the page.
Volunteer profiles always open as pages. Session/authenticator changes preserve
unsaved profile answers. If a change revokes the current session or organizer
access, the browser still navigates to sign-in or the volunteer portal.
