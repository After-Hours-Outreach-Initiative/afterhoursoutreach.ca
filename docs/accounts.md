# Accounts

How volunteers apply and sign in, and how organizers are told apart from
volunteers.

## Authentication

Authentication is passwordless, using an emailed link or code.

1. The person enters their email address.
2. The email holds a sign in link and a 6 digit code. Having both lets someone
   open the email on a different device from the one they are signing in on.
3. The link opens a confirmation page on whichever device opens it, then
   redirects to the page they started from. The code signs in the device that
   asked for it.
4. Using one spends the other. Both expire after 10 minutes. 3 wrong codes cancel
   the request and a new one has to be asked for.
5. Requesting another email replaces the previous code and link.

The first sign in with a new address creates the account and goes to the
application form at `/apply`. See [Application](#application).

Better Auth's official Email OTP plugin generates, stores, expires, and consumes
the code, creates verified accounts, and manages sessions. The link carries that
same code in its URL fragment, not a separate token; fragments are not sent in
HTTP requests. The completion page clears the fragment from browser history.
Only pressing **Confirm sign-in** submits the code, so simply visiting the page
does not consume it, including when a mail scanner runs JavaScript.

The generated database baseline uses Better Auth's verification table, not the
old email-challenge table. See [database migrations](../src/server/db/README.md)
before rebuilding a pre-production database that used the old migration history.

## Application

1. `/volunteer` has a button to create an account.
2. The person signs in. See [Authentication](#authentication).
3. A new account goes to the application form at `/apply`. The privacy notice is shown at
   the top.
4. After the team choices, the Code of Conduct initially shows the first two
   rules, fading into the dark background near the bottom. **Read all rules**
   expands the remaining rules and removes the fade; **Show fewer rules** appears
   below the final rule and collapses them again. The required, initially unchecked
   acknowledgement stays visible below in both states, before **Complete application**.

New applications require `codeOfConductAccepted: true` in the profile API too;
omitted, false, and non-boolean values cannot create a profile. The server saves
the rules version and acknowledgement time with the profile in the same
transaction. Profile edits neither require the checkbox again nor change that
record. Existing and synthetic profiles are not backfilled with invented consent.
The additive `code_of_conduct` migration must be applied before deploying this
change; it preserves existing accounts and profile answers.

After applying, volunteers wait for an organizer to approve their application
from **Volunteers → View profile and approval → Approve application**. Until then,
they can edit their account but cannot view events or sign up for orientations.
Pending applications appear first in the volunteer list. Organizers retain event
and review access through their role, with an active, completed application.

Application approval enables event viewing and orientation sign-ups. Patrol
approval remains a separate decision; completing orientation does not grant it
automatically. Both approval changes are audited, and emails require organizer
opt-in. Revoking application approval cancels future volunteer event sign-ups.

Apply `0002_registration_approval.sql` before deploying. Existing volunteers also
start awaiting approval, including those already approved for patrols. Profiles,
patrol approvals, and existing sign-up records are preserved by the migration.

`/apply` is the canonical application URL. GET requests to `/register` and
`/volunteer/register` redirect there permanently; legacy query strings are not
forwarded. Sign-in return URLs also normalize those older paths to `/apply`.
The application and redirects retain private-page headers (no caching/indexing).
Event registrations reserve event spots; they are separate from volunteer applications.

The form definitions live in `src/data/application.ts`. The profile endpoint
remains `/api/v1/account/profile`, since it also handles ongoing profile edits.
Organizer status requests use `applicationApproved`; the old `registrationApproved`
input is accepted for older open forms, but conflicting values are rejected.
See [storage compatibility](../src/server/db/README.md#application-storage-compatibility)
for the unchanged SQL names and historical records. No data migration is needed
for this terminology change.

### Profile

Application answers are saved with the person's profile. Ongoing contact,
safety, training, and team-interest answers can be seen and edited at
`/volunteer/account`.

Email appears first during application. On the account page it appears in
**Account settings**, not in the profile form.

Both forms use larger section headings with horizontal dividers: **Personal
info**, **Emergency contact**, **Training and safety**, and **Team interests**.
Application also includes **About volunteering** and **Code of Conduct**.

**Save profile** is greyed out until an answer or team selection differs from
the saved profile. Reverting every change disables it again. Successful saves
establish the new baseline; failed saves remain retryable, and edits made while
a save is pending stay unsaved. **Complete application** is unaffected.

“How did you find out about us?”, “Why do you want to volunteer?”, and the Code of
Conduct are editable only during application, not on the volunteer's profile.
Organizers can view referral answers on profile pages/dialogs; motivation and
the acknowledgement are not displayed there. The server preserves these
application-only answers and the acknowledgement record when a profile is edited. New
applications still require both questions and the acknowledgement; profile
updates omit them, and older clients cannot overwrite the saved answers.

Volunteers can edit ongoing profile answers. Changes are logged without copying
sensitive answers into the log and do not change patrol approval. Email changes
use the separate verification flow described below. All organizers can view
profile fields, and each profile view is logged. Accounts with an authenticator
enabled must verify it when signing in.

### Fields

Questions are based on the current Google Form. The referral and motivation
questions and Code of Conduct confirmation are application-only. Organizers can
view referral answers and the remaining profile answers.

| Field                                                     | Required                                             |
| --------------------------------------------------------- | ---------------------------------------------------- |
| First name                                                | Yes                                                  |
| Middle name(s)                                            | No                                                   |
| Last name                                                 | Yes                                                  |
| Preferred name                                            | No                                                   |
| Email (from the account)                                  | Yes                                                  |
| Pronouns                                                  | No                                                   |
| Phone number                                              | Yes                                                  |
| Date of birth                                             | Yes                                                  |
| Emergency contact name                                    | Yes                                                  |
| Emergency contact phone                                   | Yes                                                  |
| Emergency contact relationship                            | Yes                                                  |
| How did you find out about us                             | At least one choice; short detail required for Other |
| Why do you want to volunteer                              | Yes                                                  |
| Teams (outreach, medic, non-patrol)                       | Yes                                                  |
| Highest medical certification                             | Yes                                                  |
| Other training and experience, and other                  | Yes                                                  |
| Medical conditions/allergies/anything else we should know | No                                                   |
| Code of Conduct acknowledgement                           | On application                                       |

New applicants must provide first and last names. Middle names, preferred name,
and pronouns are optional. Account menus, volunteer lists, and event rosters use
the preferred name when supplied, otherwise the first, middle, and last names
together. Organizers can view each component and search by full or preferred name.

Apply `0006_profile_name_components.sql` before deploying. This additive migration
leaves existing combined-name answers untouched in `preferred_name`, with null
name components; it never splits or guesses anyone's name. Existing account and
organizer views explain that the old answer is retained in Preferred name. Those
volunteers may keep editing with both first and last names blank, provided their
previous name remains, or supply both. Once supplied, both remain required.

Referral choices are Social Media, Friend/Word of mouth, Internet, and Other.
Other requires a nonblank detail of at most 200 characters. Unchecking Other
clears its text; the server ignores stale detail text when Other is not selected.
Apply `0007_profile_referral_sources.sql` before deploying. Its nullable JSON
`heard_about_us_sources` and text `heard_about_us_other` columns follow the
existing multi-select storage convention. The original `heard_about_us` column
is kept verbatim for legacy answers, without guessing choices or backfilling
details. Account edits do not rewrite any referral columns, including legacy
nulls, and organizers see the original free text when present.

Date of birth, emergency contact, and medical conditions each have a short line
under them saying what the information is used for.

Certification uploads, expiry reminders, and volunteer hours are deferred.

### Discord

Discord account linking is deferred. A future optional link could grant a
patrol-approved Discord role based on organizer approval on the website; the
website remains the source of truth for patrol access.

## Two factor for organizers

Two-factor authentication is optional for both organizers and volunteers. They
can add an authenticator app (TOTP) from their account settings. Backup codes are
given when TOTP is set up. Once enabled, the authenticator or a backup code is
required each time that account signs in.

## Sessions

Sessions are kept in a cookie that is marked HttpOnly, Secure, and
SameSite=Lax. They last 30 days and renew while the person keeps using the
site. Signing out ends the session on that device. `/volunteer/account` lists
active sessions and can end them.

## Changing email

1. The volunteer enters the new address on `/volunteer/account`.
2. A confirmation link is sent to the new address. Nothing changes until it is
   clicked.
3. A notice is sent to the old address.
4. The account id stays the same, so the profile, signups, and orientation
   completion carry over.

If the new address already has an account, the change is blocked.

If someone has lost access to their old address, a developer changes it in the
database.

## Roles

Every account has one role:

- `volunteer`: the default for new accounts.
- `organizer`: can manage events and volunteers.

Any organizer can give the organizer role to any account, or take it away,
without needing another organizer to agree. Organizers sign in the same way as
everyone else. There is no separate organizer login.

A developer manually assigns the first organizer role to a specific verified
account. After that, organizers manage roles through the website.

## Abuse protection

Sign in requests are rate limited to reduce fake accounts and mailbombing.
Requests are counted by both the address being sent to and the IP asking,
since either one on its own is easy to work around.

Sign-in emails have a 30-second per-address cooldown; email-change requests keep
a one-minute cooldown. Both share limits of three per address per hour, ten per
IP per hour, and 80 total per day. Counters are stored in D1.

Code verification: 3 attempts per code, plus 10 submissions per address per hour
and 30 per IP per minute. The per-address budget survives resends and code rotation.
Codes are stored hashed in Better Auth's verification table.

## Local development tools

Development-only browser scripts and email-dialog styles live in `src/dev/`,
alongside the server account-switching plugin. Shared application code loads
them through dynamic imports guarded by `import.meta.env.DEV`. The guard is
replaced at build time, so both production and preview builds exclude these
modules. The folder name itself does not exclude code from a build; keep every
runtime import from outside `src/dev/` behind the guard. Type-only imports are
safe because TypeScript removes them.

The development controls are available only in the local dev server. Built
Worker tests check that `GET /api/v1/auth/dev/users` and
`POST /api/v1/auth/dev/switch-user` return `404` in production and preview builds;
local browser tests exercise account switching and simulated email delivery.
Dev-tool assets must not be placed in `public/`, which is copied into builds.

## TODO

- TODO: decide if the medical certification should be checked, for example by
  asking for a licence number or a photo of the certificate. If so, uploads
  need R2 storage and more privacy work.
- TODO: fix the typos in the current form options when copying them over
  ("Nalaxone", "wiith", "Pa:ramedic", "relatons", "opiod", "ventiliation").
- TODO: decide if volunteers also need a waiver as part of applying.
