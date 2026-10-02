# Accounts

How volunteers register and sign in, and how organizers are told apart from
volunteers.

## Authentication

Authentication is passwordless, using an emailed link or code.

1. The person enters their email address.
2. The email holds a sign in link and a 6 digit code. Having both lets someone
   open the email on a different device from the one they are signing in on.
3. The link signs in whichever device opens it, with no button to press, and
   redirects to the page they started from. The code signs in the device that
   asked for it.
4. Using one spends the other. Both expire after 1 hour. 10 wrong codes cancel
   the request and a new one has to be asked for.

The first sign in with a new address creates the account and goes to the
registration form. See [Registration](#registration).

Opening the link is not what spends the token. The link opens a page, and that
page makes the request that completes the sign in. Mail scanners and link
previewers fetch every URL in a message without running the page, so the link
still works when the person gets to it.

## Registration

1. `/volunteer` has a button to create an account.
2. The person signs in. See [Authentication](#authentication).
3. A new account goes to the registration form. The privacy notice is shown at
   the top.

After registration is complete the new volunteer account will only be able to
sign up for orientation events until an organizer manually approves patrol
access. Completing orientation is the most common path to approval, but is not
required and does not automatically grant approval.

### Profile

Everything from the form is saved as the person's profile. They can see and
edit it at `/volunteer/account`, and delete their account from there.

Volunteers can edit all registration answers. Changes are logged without copying
sensitive answers into the log and do not change patrol approval. Email changes
use the separate verification flow described below. All organizers can view
profile fields after verifying two factor, and each profile view is logged.

### Fields

Taken from the current Google Form. The volunteer and organizers can see all of
them.

| Field                                    | Required |
| ---------------------------------------- | -------- |
| Full or preferred name                   | Yes      |
| Email (from the account)                 | Yes      |
| Pronouns                                 | No       |
| Phone number                             | Yes      |
| Date of birth                            | Yes      |
| Emergency contact name                   | Yes      |
| Emergency contact phone                  | Yes      |
| Emergency contact relationship           | Yes      |
| How did you hear about us                | Yes      |
| Why do you want to volunteer             | Yes      |
| Teams (outreach, medic, non-patrol)      | Yes      |
| Highest medical certification            | Yes      |
| Other training and experience, and other | Yes      |
| Medical conditions or triggers           | No       |

Date of birth, emergency contact, and medical conditions each have a short line
under them saying what the information is used for.

Certification uploads, expiry reminders, and volunteer hours are deferred.

### Discord

Discord account linking is deferred. A future optional link could grant a
patrol-approved Discord role based on organizer approval on the website; the
website remains the source of truth for patrol access.

## Two factor for organizers

Organizers must have an authenticator app (TOTP) set up before any volunteer
profile is shown to them. Backup codes are given when TOTP is set up.

Volunteers can add TOTP if they want, but do not have to.

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

## TODO

- TODO: decide if the medical certification should be checked, for example by
  asking for a licence number or a photo of the certificate. If so, uploads
  need R2 storage and more privacy work.
- TODO: fix the typos in the current form options when copying them over
  ("Nalaxone", "wiith", "Pa:ramedic", "relatons", "opiod", "ventiliation").
- TODO: decide if volunteers need to accept a code of conduct or waiver as part
  of registering.
