---
title: Notification delivery
description: Email transport, transactional outboxes, delivery retries, and scheduled medic reminders.
---

Implements the [Notifications specification](/specification/notifications/).
Message examples are available in [Email previews](/implementation/emails/).

## Transport and templates

Notifications are sent through the Cloudflare Email Service `EMAIL` binding
(`src/server/email.ts`) from `info@afterhoursoutreach.ca`.
Sign-in and email-change messages use `accounts@afterhoursoutreach.ca`.
Emails include "Questions? Ask us on Discord" and a link to the Discord server.

Account and notification mail share one budget: 200 per UTC day and 3,000 per
32 UTC days, so any billing month stays within the 3,000 emails included with
Workers Paid.

The binding has no idempotency keys. A send rejected before sending can be
retried. A send that may have been accepted (a server error, a timeout, or a
lapsed lease) is final and never sent again, to avoid duplicates.

Message formatting is shared in `src/data/email-templates.ts`. Fictional gallery
examples live in `docs/src/email-previews/catalog.ts`; update them when adding a
message type or content branch. Local delivery uses the normal flow and always
succeeds without sending. Branch previews have no binding: sign-in and
email-change messages are shown on screen instead, and other mail is not sent.

## Event and access notifications

Opted-in notification records are written in the same transaction as the change.
An application approval also writes a notice to the organization inbox in that
transaction, sent with the volunteer's email. Branch previews skip the notice.
Skipping email creates no outbox records, so there is nothing to send on retry.
Delivery failure leaves the change saved and the notification pending. Each
email is its own batch and request, and a run stops after 30 seconds;
organizers can retry rejected notifications from the result dialog. An
unconfirmed email is cancelled and the organizer is told to contact the
recipient. There is no scheduled dispatcher yet. D1 leases protect against
concurrent duplicate sends. The original sending origin is frozen so retries on
branches sharing preview D1 keep the same payload. Retries stop 23 hours after
creation; older pending records require manual follow-up, not a blind resend.
Local D1 delivery never sends and is treated as sent.

## Undo timer

Changes that would email someone are checked, then stored in `pending_action`
with their validated request instead of being made. When the timer ends, the
same action code replays the request as its organizer, using one of their live
sessions or, once they have signed out, a session made for that run and deleted
after it. `pending_action_target` locks the changed items, including the
occurrences a series change reaches. Finished actions are deleted after 30 days. `event_capacity_hold` keeps the limits of waiting event edits,
and sign-up triggers reject bookings that do not fit them. The organizer's open
page makes the change on time; the minute cron and organizer page loads make any
that are overdue.

## Medic certification reminders

`src/worker.ts` preserves Astro's fetch handler and adds Cron Triggers from
`wrangler.jsonc`: daily discovery at **16:00 UTC**, and
delivery/retries at **30 minutes past each hour**. Daily discovery also delivers
one batch. Deploy the built `dist/server/wrangler.json` as usual, not the source
Worker directly. Trigger changes can take up to 15 minutes to propagate.

Eligibility, date windows, and catch-up behavior are defined in the
[Notifications specification](/specification/notifications/#medic-certification-reminders).
Calendar comparisons use `America/Vancouver`. Account links use the configured
HTTPS `AUTH_BASE_URL`, never a request host.

- Each run sends at most **five** emails, serially paced, sharing the email
  budget with sign-in/event mail. Unattempted backlog can
  wait while still relevant; budget exhaustion does not start its retry clock.
- The generated schema includes the persistent notification outbox/ledger.
  A unique `(user_id, expiry, kind)` key and atomic token-owned leases prevent
  concurrent sends. Renewing
  to a different date creates a new cycle; never delete ledger rows to retry mail.
- The exact recipient and request are frozen on the first provider attempt.
  Rejected sends retry hourly for **less than 23 hours from that attempt**. An
  unconfirmed send (a timeout, a server error, or a failed post-send database
  write) becomes `expired` at once. `expired` requires manual delivery
  investigation; automatic resend is deliberately disabled to prevent
  duplicates. This status means delivery is unresolved, not certificate expiry.
  Renewal, loss of eligibility, a changed recipient, or leaving the applicable
  date window cancels stale mail. Cancelled cycles are not automatically restarted.
  Payloads are cleared on terminal states; logs contain aggregate counts only.
- Monitor the `medic_certification_notifications` aggregate log and failed Cron
  Events, especially pending backlog and expired delivery counts. Inspect only
  status/count fields when diagnosing; do not export recipient/payload fields.

Before production deployment, verify the dedicated production D1 binding,
configure `BETTER_AUTH_SECRET`, and verify that Email Sending is enabled for
the domain (`wrangler email sending list`). `pnpm deploy` applies generated migrations to the guarded
production database before uploading the Worker. No new secrets or services
are needed. Local/dev and `APP_ENV != production` (including branch previews)
skip the job without sending or consuming notifications; automated tests inject a
mock provider against isolated D1. No remote migration, deployment, or real email
is performed by the build or tests.

References: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Astro custom Worker entrypoint](https://docs.astro.build/en/guides/integrations-guide/cloudflare/#changed-custom-entrypoint-api),
[Email Service Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
