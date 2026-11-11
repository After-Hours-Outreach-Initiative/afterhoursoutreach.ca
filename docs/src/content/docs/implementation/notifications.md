---
title: Notification delivery
description: Email transport, transactional outboxes, delivery retries, and scheduled medic reminders.
---

Implements the [Notifications specification](/specification/notifications/).
Message examples are available in [Email previews](/implementation/emails/).

## Transport and templates

Notifications are sent through Resend's API from `info@afterhoursoutreach.ca`.
Sign-in and email-change messages use `accounts@afterhoursoutreach.ca`.
Emails include "Questions? Ask us on Discord" and a link to the Discord server.

Account and notification mail share the application's 80-per-day budget.
Provider quotas must be checked separately when configuring delivery.

Message formatting is shared in `src/data/email-templates.ts`. Fictional gallery
examples live in `docs/src/email-previews/catalog.ts`; update them when adding a
message type or content branch. Local delivery uses the normal flow with
simulation controls; production and hosted previews exclude those controls.

## Event and access notifications

Opted-in notification records are written in the same transaction as the change.
An application approval also writes a notice to the organization inbox in that
transaction, sent with the volunteer's email. Branch previews skip the notice.
Skipping email creates no outbox records, so there is nothing to send on retry.
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

- Each run sends at most **five** emails, serially paced like event mail, sharing
  the existing **80/day** budget with sign-in/event mail. Unattempted backlog can
  wait while still relevant; budget exhaustion does not start its retry clock.
- The generated schema includes the persistent notification outbox/ledger.
  A unique `(user_id, expiry, kind)` key, atomic token-owned leases,
  and stable Resend idempotency keys prevent concurrent/replayed sends. Renewing
  to a different date creates a new cycle; never delete ledger rows to retry mail.
- The exact recipient and request are frozen on the first provider attempt.
  Failures (including an ambiguous timeout or a failed post-send database write)
  retry hourly for **less than 23 hours from that attempt**, within Resend's
  24-hour idempotency lifetime. After that, status `expired` requires manual
  delivery investigation; automatic resend is deliberately disabled to prevent
  duplicates. This status means delivery is unresolved, not certificate expiry.
  Renewal, loss of eligibility, a changed recipient, or leaving the applicable
  date window cancels stale mail. Cancelled cycles are not automatically restarted.
  Payloads are cleared on terminal states; logs contain aggregate counts only.
- Monitor the `medic_certification_notifications` aggregate log and failed Cron
  Events, especially pending backlog and expired delivery counts. Inspect only
  status/count fields when diagnosing; do not export recipient/payload fields.

Before production deployment, verify the dedicated production D1 binding,
configure `BETTER_AUTH_SECRET` and `RESEND_API_KEY`, and verify the Resend
sender/domain. `pnpm deploy` applies generated migrations to the guarded
production database before uploading the Worker. No new secrets or services
are needed. Local/dev and `APP_ENV != production` (including branch previews)
skip the job without sending or consuming notifications; automated tests inject a
mock provider against isolated D1. No remote migration, deployment, or real email
is performed by the build or tests.

References: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Astro custom Worker entrypoint](https://docs.astro.build/en/guides/integrations-guide/cloudflare/#changed-custom-entrypoint-api),
[Resend idempotency lifetime](https://resend.com/docs/dashboard/emails/idempotency-keys).
