# Data model

The D1 tables. Better Auth owns its own tables. The rest are ours.

## Better Auth tables

- `user`: id, email, name, role, created at.
- `session`: one row per signed in device.
- `verification`: pending sign in links and codes.
- `passkey`: registered passkeys.
- `two_factor`: TOTP secrets and backup codes.

## Our tables

### `profile`

One row per user, holding the registration form answers. See
[volunteer-registration.md](volunteer-registration.md) for the fields.

Multi-choice answers (teams, other training) are stored as JSON arrays.

### `volunteer_status`

- user id
- status: `pending`, `approved`, or `inactive`
- changed by (user id of the organizer)
- changed at

### `patrol`

The same fields as `Patrol` in `src/data/patrols.ts`: date, start time, meeting
point, map link, spots, open.

### `signup`

- id
- patrol id
- user id
- status: `confirmed` or `cancelled`
- created at

Name and contact details come from the user and profile, not the signup.

### `profile_access_log`

- organizer user id
- volunteer user id
- accessed at

## TODO

- TODO: decide if cancelled signups are kept, or deleted.
- TODO: decide if past patrols and their rosters are kept, and for how long.
- TODO: decide if the medical conditions field should be encrypted in the app
  on top of D1's encryption at rest.
