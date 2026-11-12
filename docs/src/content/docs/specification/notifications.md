---
title: Notifications
description: Account messages, organizer email choices, and medic certification reminders.
---

This page defines when the application sends email and how notification outcomes
affect the underlying action. Transport, outboxes, scheduling, and retries live
in [Notification delivery](/implementation/notifications/). Message examples live
in [Email previews](/implementation/emails/).

## Account messages

Send verification email for sign-in and to confirm a new account email address
before the change takes effect. The account and access rules follow the
[Accounts specification](/specification/accounts/). Message formats, verification
expiry, and retry limits belong in [Account implementation](/implementation/accounts/#authentication).

## Organizer choices

Approving, rejecting, or revoking an application, and approving or revoking
patrol approval from a volunteer profile, always email the volunteer once the
organizer confirms. Rejection and revocation require a reason, which the email
includes. Approving an application also emails the organization inbox,
info@afterhoursoutreach.ca, with the applicant, the approving organizer, and a
link to their profile.

Changing active status, roles, event details, or event cancellation, approving
patrols from an event roster, and moving or removing a volunteer's sign-up email
the affected volunteers. A reason may accompany relevant changes. If access
revocation cancels future sign-ups, their cancellation emails are included.
Delivery failure leaves the underlying change saved and exposes pending delivery
for follow-up. Organizers can retry pending notifications; unresolved older
deliveries require investigation.

Volunteer self-service sign-ups and cancellations, event creation, and orientation
completion confirm on screen without sending email.

### Undo timer

An organizer change that would email anyone waits five minutes before it is made,
or until 15 minutes before the event it changes starts if that is sooner. Closer
than that, it is made at once. It is made even if its organizer signs out, as long
as they are still an active organizer. The organizer who made it sees a countdown
toast on every page. Every organizer
sees the countdown on the changed item, with the organizer's name when someone
else made it. Any organizer can undo the change or make it now. Volunteers see no
change while it waits, but sign-ups cannot take places that a waiting capacity
change would remove. Other changes to the same item wait until it is made or
undone; an edit refused for this shows the waiting change as a toast. Undoing an
edit reopens its form as it was entered. A change that fails when its timer ends
stays in its organizer's toasts with the reason.

## Medic certification reminders

Reminder behavior exists in the implementation, with production activation
dependent on the configuration described in
[Deployment](/implementation/deployment/).

- Eligibility requires a verified, active volunteer account, the medic team,
  a recognized structured certification, and a valid expiry date. Legacy free-text
  certification answers are not inferred.
- Send a warning once when the certificate enters the 30-calendar-day expiry
  window, including the expiry day.
- Send a separate expired message starting the following day. A certificate is
  valid through its expiry date; calendar comparisons use America/Vancouver.
- Catch-up includes certificates already within the warning window and expiry
  dates from the previous seven calendar dates. Older expiries are not backfilled.
- A renewed expiry date starts a new reminder cycle. Renewal, loss of eligibility,
  changed recipient, or leaving the applicable window cancels stale pending mail.
- Reminder retries must avoid duplicate messages. Unresolved delivery after the
  retry window requires manual follow-up.

Local development and hosted branch previews do not send these reminders.
Certificate verification, uploads, and hours tracking remain separate
[planning questions](/planning/#applications-and-qualifications).
