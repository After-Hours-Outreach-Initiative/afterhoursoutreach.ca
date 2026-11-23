---
title: Test scenarios and edge cases
description: Manual scenarios that exercise the most failure-prone volunteer workflows.
---

Use this checklist when reviewing a change. Each scenario should be tested with
the smallest role that can perform it, and the expected result should be checked
after a refresh as well as immediately after the action.

## Accounts and applications

- A visitor starts an application, saves a draft, signs out, and resumes it
  from a different browser; the draft remains private and all completed steps
  are preserved.
- An applicant submits an application with an expired medical certification,
  then corrects the date after an organizer rejects it; the resubmission is
  accepted without creating a second account.
- Two tabs submit the same application at nearly the same time; only one
  submission is recorded and the user sees a recoverable error if the second
  request loses the race.
- A user requests an email change, follows an expired or already-used link, and
  then requests a fresh link; the old link cannot change the account.
- An organizer disables an account while that person has an active session;
  subsequent protected requests fail and public pages remain accessible.

## Events and reservations

- The final available volunteer spot is booked from two tabs; one reservation
  succeeds and the other receives a full-capacity response without a duplicate.
- A volunteer cancels immediately before an organizer closes an event; the
  event's attendee count and wait-list state remain consistent after refresh.
- A past event is opened directly by URL, including by an organizer; editing
  permissions follow the role and the event's past status rather than the URL.
- An orientation reaches its minimum capacity, then one attendee unregisters;
  the minimum-capacity warning and remaining reservations update together.
- A recurring event is edited for one occurrence; other occurrences keep their
  original schedule and volunteer limits.

## Notifications and integrations

- A notification has no optional recipient, a recipient that has opted out, or
  a provider failure; the action is still auditable and the user-facing result
  explains whether retrying is possible.
- A Discord identity is linked twice or belongs to another account; the second
  link is rejected without removing the existing valid link.
- An email provider times out after accepting a message; retries do not create
  duplicate user-visible actions.

## Privacy and recovery

- A user requests account deletion with a pending application, reservations,
  and email-change token; personal data is removed while required operational
  records stay anonymised and referentially valid.
- A request is repeated after a network retry; it is idempotent and does not
  create duplicate applications, bookings, notifications, or audit entries.
- A signed-out user follows a bookmarked protected URL; they are returned to
  sign-in and then sent back to the original page without leaking its contents.
