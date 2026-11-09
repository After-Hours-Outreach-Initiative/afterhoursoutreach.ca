---
title: Events and registrations
description: Event refresh, visibility compatibility, concurrency, and notification boundaries.
---

Implements the [Events specification](/specification/events/).

## Refresh and authorization

The browser checks `/api/v1/events/version` every five seconds, or every 60 seconds
while awaiting application approval, and refreshes event cards only when their
scoped version changes. Approval is detected automatically and restores five-second
polling. Polling pauses in hidden tabs and checks immediately when returning to the
page. Your own saved changes still refresh immediately; filters, focus, and open
editor drafts are preserved.

Event details are protected at the API boundary as well as on rendered pages.
Anonymous and pending-account versions contain no event details or event-activity
signal.

## Visibility compatibility

The existing `open`/`hidden` API and database fields remain compatible. The
editor saves them together (`true`/`false` when on, `false`/`true` when off).
Older events with either registration closed or the event hidden are treated
as off until an organizer explicitly turns visibility on.

## Persistence and concurrency

`/volunteer` is request-rendered and lists D1 records. D1 triggers enforce the
[eligibility and capacity rules](/specification/events/) across concurrent
requests. Edits use version checks to reject stale writes rather than overwrite
another organizer's changes.

Cancellation retains existing registration and attendance history. An occurrence
that has never had registrations may be removed; recurring cancellation
tombstones are retained. Hiding/closing updates visibility and registration state
without cancelling existing bookings. Access-revocation workflows cancel affected
future bookings atomically.

Organizer mutations default to no email unless the API receives `notify: true`.
The prompt behavior and silent actions are defined in the
[Notifications specification](/specification/notifications/#organizer-choices).

See [Notification delivery](/implementation/notifications/) for transactional
outboxes, leases, and retry limits.
