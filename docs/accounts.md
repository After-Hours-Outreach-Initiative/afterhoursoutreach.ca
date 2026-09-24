# Accounts

How people sign in, and how organizers are told apart from volunteers.

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
registration form. See [volunteer-registration.md](volunteer-registration.md).

Opening the link is not what spends the token. The link opens a page, and that
page makes the request that completes the sign in. Mail scanners and link
previewers fetch every URL in a message without running the page, so the link
still works when the person gets to it.

## Passkeys

After signing in, a person can add a passkey from `/account`. After that they
can sign in with the passkey and skip the email.

## Two factor for organizers

Organizers must have a passkey or an authenticator app (TOTP) set up before any
volunteer profile is shown to them. Backup codes are given when TOTP is set up.

Volunteers can add TOTP if they want, but do not have to.

## Sessions

Sessions are kept in a cookie that is marked HttpOnly, Secure, and
SameSite=Lax. They last 30 days and renew while the person keeps using the
site. Signing out ends the session on that device. `/account` lists active
sessions and can end them.

## Roles

Every account has one role:

- `volunteer`: the default for new accounts.
- `organizer`: can manage patrols and volunteers.

Organizers can make other accounts organizers, or take the role away.
Organizers sign in the same way as everyone else. There is no separate
organizer login.

## Abuse protection

The sign in form is protected so no one can fill a patrol with fake accounts
or mailbomb someone:

- Turnstile on the sign in form.
- Rate limit on sign in requests, counted by both the address being sent to and
  the IP asking, since either one on its own is easy to work around.

## TODO

- TODO: confirm 30 days is the right session length.
- TODO: decide who the first organizers are, and set their role by hand when
  the database is set up.
- TODO: decide if one organizer can remove another organizer's role, or if that
  needs a second organizer to agree.
- TODO: decide what happens when someone changes their email address.
