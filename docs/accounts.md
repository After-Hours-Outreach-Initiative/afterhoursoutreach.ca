# Accounts

How volunteers register and sign in, and how organizers are told apart from
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
registration form. See [Registration](#registration).

Better Auth's official Email OTP plugin generates, stores, expires, and consumes
the code, creates verified accounts, and manages sessions. The link carries that
same code in its URL fragment, not a separate token; fragments are not sent in
HTTP requests. The completion page clears the fragment from browser history.
Only pressing **Confirm sign-in** submits the code, so simply visiting the page
does not consume it, including when a mail scanner runs JavaScript.

The generated database baseline uses Better Auth's verification table, not the
old email-challenge table. See [database migrations](../src/server/db/README.md)
before rebuilding a pre-production database that used the old migration history.

## Registration

1. `/volunteer` has a button to create an account.
2. The person signs in. See [Authentication](#authentication).
3. A new account goes to the registration form. The privacy notice is shown at
   the top.
4. After the team choices, the Code of Conduct initially shows the first two
   rules, fading into the dark background near the bottom. **Read all rules**
   expands the remaining rules and removes the fade; **Show fewer rules** appears
   below the final rule and collapses them again. The required, initially unchecked
   acknowledgement stays visible below in both states, before **Complete registration**.

New registration requires `codeOfConductAccepted: true` in the profile API too;
omitted, false, and non-boolean values cannot create a profile. The server saves
the rules version and acknowledgement time with the profile in the same
transaction. Profile edits neither require the checkbox again nor change that
record. Existing and synthetic profiles are not backfilled with invented consent.
The additive `code_of_conduct` migration must be applied before deploying this
change; it preserves existing accounts and profile answers.

After registration is complete the new volunteer account will only be able to
sign up for orientation events until an organizer manually approves patrol
access. Completing orientation is the most common path to approval, but is not
required and does not automatically grant approval.

### Profile

Registration answers are saved with the person's profile. Ongoing contact,
safety, training, and team-interest answers can be seen and edited at
`/volunteer/account`.

Email appears first during registration. On the account page it appears in
**Account settings**, not in the profile form.

Both forms use larger section headings with horizontal dividers: **Personal
info**, **Emergency contact**, **Training and safety**, and **Team interests**.
Registration also includes **About volunteering** and **Code of Conduct**.

**Save profile** is greyed out until an answer or team selection differs from
the saved profile. Reverting every change disables it again. Successful saves
establish the new baseline; failed saves remain retryable, and edits made while
a save is pending stay unsaved. **Complete registration** is unaffected.

“How did you hear about us?”, “Why do you want to volunteer?”, and the Code of
Conduct appear only during registration, not on the volunteer's profile or
organizer profile pages/dialogs. The server preserves these registration-only
answers and the acknowledgement record when a profile is edited. New
registration still requires both questions and the acknowledgement; profile
updates omit them, and older clients cannot overwrite the saved answers.

Volunteers can edit ongoing profile answers. Changes are logged without copying
sensitive answers into the log and do not change patrol approval. Email changes
use the separate verification flow described below. All organizers can view
profile fields, and each profile view is logged. Accounts with an authenticator
enabled must verify it when signing in.

### Fields

Questions are based on the current Google Form. The referral and motivation
questions and Code of Conduct confirmation are registration-only; the volunteer
and organizers can see the remaining profile answers.

| Field                                    | Required        |
| ---------------------------------------- | --------------- |
| Full or preferred name                   | Yes             |
| Email (from the account)                 | Yes             |
| Pronouns                                 | No              |
| Phone number                             | Yes             |
| Date of birth                            | Yes             |
| Emergency contact name                   | Yes             |
| Emergency contact phone                  | Yes             |
| Emergency contact relationship           | Yes             |
| How did you hear about us                | Yes             |
| Why do you want to volunteer             | Yes             |
| Teams (outreach, medic, non-patrol)      | Yes             |
| Highest medical certification            | Yes             |
| Other training and experience, and other | Yes             |
| Medical conditions or triggers           | No              |
| Code of Conduct acknowledgement          | On registration |

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

Email requests: one per address per minute, three per address per hour, ten per
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
- TODO: decide if volunteers also need a waiver as part of registering.
