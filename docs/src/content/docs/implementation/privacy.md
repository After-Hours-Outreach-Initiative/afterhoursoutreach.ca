---
title: Privacy implementation review
description: Current code evidence for collection notices, drafts, account deletion, data access, and retention limits.
---

Reviewed against the repository on **November 9, 2026**. This replaces the stale
October 15 snapshot. It describes source behavior, not a check of live provider
accounts or organizational approvals. The [Privacy specification](/specification/privacy/)
records the policy baseline; [Planning](/planning/privacy/) holds discrepancies
and evidence to confirm.

## Collection notices and drafts

`src/pages/apply.astro` displays an account/browser autosave notice before
`AccountProfileForm`, with a privacy-policy link. The footer links the policy
across the website. The ordinary sign-in panel has no inline policy link; the
remaining notice question is tracked in Planning.

`src/server/db/application-drafts.ts` stores drafts in D1; browser backup and
synchronization live in `src/scripts/application-draft.ts`. Draft writes bind the
account and current draft generation and reject stale writes across discard.
Discard changes generation atomically, with database-trigger deletion of the
answer row. `ApplicationDraftDiscard.astro` exposes the normal-flow control;
the browser clears local copies, handles retries, and pauses saving so old answers
are not silently restored. Answer-free generation markers remain.

Successful submission removes the account draft and the current browser copy.
Sign-out clears synced browser copies but leaves unsynced backups. Offline
browsers cannot be remotely erased; old copies must be handled on reconnect or
by clearing site data. Drafts are not returned through organizer profile views.
There is no time-based automatic abandoned-draft purge.

Sources: [application page](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/pages/apply.astro),
[draft persistence](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/db/application-drafts.ts), and
[browser draft handling](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/scripts/application-draft.ts).

## Submission records and profile edits

`src/server/db/profiles.ts` captures original answers, account email, submission
time, and the Code of Conduct version/acknowledgement time in the first successful
profile insert. Retries and profile edits do not replace that snapshot or invent
snapshots for older profiles. Application-only answers remain unchanged on edits.

The current profile read-only field list in `src/data/application.ts` contains
**birth date only**. Legal-name fields remain editable, contrary to the public
policy's correction wording. Profile-edit audits store changed field names,
not full answer copies. An original submission and those audit entries do not
constitute a complete answer snapshot for every subsequent approval/access decision.

## Sign-in-account deletion

`POST /api/v1/account/delete` requires same origin, a verified account, the enabled
second factor, a session created within ten minutes, the current email, matching
user ID, and explicit confirmation. The persistence write rechecks session,
email, and freshness, then replaces the identity and marks `deleted_at`.

The `account_deleted` trigger atomically:

- deletes sessions, credentials, authenticator records, related verification
  records, account drafts/generation metadata, and pending Discord authorization;
- deactivates the volunteer and cancels confirmed future sign-ups;
- stops affected frozen event-email batches and pending submission/medic mail,
  without promising recall of accepted or in-flight messages;
- clears join tokens and leaves minimal Discord identity/sync state for durable
  managed-role removal.

Deleted identities cannot be reactivated or issued new sessions. Volunteer
management/profile queries exclude them. Submitted profile answers, the original
application, history, and delivery records are retained, so this action is not a
full personal-data purge. The former email can create a separate new identity.
The Discord worker removes the residual link after roles are removed or the
member is absent. Last-organizer protections still apply.

Sources: [deletion endpoint](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/pages/api/v1/account/delete.ts),
[deletion write](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/db/account-deletion.ts),
[database triggers](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/db/triggers.sql), and
[Discord sync](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/discord/sync.ts).

## Access and roster exposure

Active authorized organizers can view full submitted profiles; profile-view
logging is written before answers are returned. Drafts are excluded. Two-factor
authentication is optional and enforced at sign-in for enrolled accounts.

`listPublicRosters` in `src/server/db/events.ts` separately authorizes eligible
volunteer viewers and returns display names, attendee category, and a medic mark
for visible upcoming events. It omits private profile fields and internal account
IDs. `VolunteerPortal.astro` and `PublicEventRoster.astro` render this limited view.
The policy's organizer-only roster statement is therefore stale.

## Email and Discord data

Hosted authentication and notification mail uses Resend; local development
simulates delivery. D1 stores delivery state and, where required, message payloads.
The review-ready notification goes to three fixed organizer inboxes with a display
name and organizer-authenticated review link rather than full answers. The current trigger is the winning Naloxone-confirmation transaction,
not the original form submission. Preview mode suppresses these organizer emails
without storing their message content.

Discord linking code stores one unique identity, consent/membership times, and
minimal synchronization state; short-lived join tokens are encrypted and refresh
tokens discarded. The application currently **pauses Discord as a completion
requirement** in `src/server/db/application-progress.ts`; do not repeat the old
claim that every new applicant must link before review. Integration code remains
present, and preview mode excludes live OAuth/sync.

## Retention and cleanup boundaries

The [public policy](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/pages/privacy.astro)
now documents manual retention rules and request handling. There is no general
scheduled cleanup of inactive drafts, profiles, event histories, or audit records.
The scheduled Worker jobs cover Discord synchronization and notification delivery.

`cleanupAuthRecords` in `src/server/db/rate-limits.ts` deletes up to 100 expired
verification records and 100 expired abuse counters per invocation, during
sign-in/email-change housekeeping. This is not a guaranteed 24-hour purge, and
session expiration is not evidence of physical record deletion. Pending-message
cleanup and duplicate-prevention ledgers also have separate lifecycles.

Current code includes role checks, private-page caching/resource restrictions,
optional two-factor authentication, and audits. Role/contact publication and
retention commitments are visible in the policy; staffing, completed manual
reviews, supporting decision records, legal holds, provider settings, training,
and restore procedures require separate operational evidence.
