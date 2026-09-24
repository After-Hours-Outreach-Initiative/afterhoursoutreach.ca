# Backend

The server side behind accounts, registration, and patrol signups.

## Stack

- `@astrojs/cloudflare` adapter. Marketing pages are prerendered. Account,
  registration, organizer, and patrol routes render on the server.
- Cloudflare D1 for the database.
- Drizzle for the schema and migrations.
- Better Auth for sign in and sessions. See [accounts.md](accounts.md).
- Resend for sign in and notification emails.
- Cloudflare Turnstile on the sign in form.

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

Sent through Resend's API from an `afterhoursoutreach.ca` address, with the
SPF, DKIM, and DMARC records Resend asks for added in Cloudflare DNS.

The Resend free plan allows 3,000 emails a month and 100 a day. The sign in
rate limit in [accounts.md](accounts.md) also protects this quota.

Resend stores the emails it sends, in the US. The privacy page has to say so.

## Environments

- Local: `astro dev` against a local D1 database.
- Production: the live Worker and D1 database.

## TODO

- TODO: decide what happens if the 100 emails a day limit is hit. Sign in
  emails should not be blocked by notifications.
- TODO: decide whose account owns Resend and Cloudflare, so it is not tied to
  one person.
- TODO: pick the sending address, for example `noreply@` or `patrols@`.
- TODO: decide if we need a staging environment or preview deploys.
- TODO: decide on database backups. D1 Time Travel covers 7 days on the free
  plan. Decide if we also want periodic exports, and where those would be
  stored safely given what is in them.
