---
title: Privacy
description: Collection, access, draft handling, account deletion, and the documented retention rules.
---

This is the privacy baseline documented in the application's policy, effective
**October 27, 2026**, reviewed against the repository on **November 9, 2026**.
It covers the website and volunteer portal; offline outreach, donations, social
media, and other Society activities need their own scope assessment.

The [policy source](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/pages/privacy.astro)
contains the full public wording. [Privacy planning](/planning/privacy/) records
known wording/code discrepancies and operational evidence still to confirm.
[Implementation](/implementation/privacy/) describes the code behind these rules.

## Collection and purpose

Explain what information is collected, why, which answers are required, who can
access it, and how to request correction or deletion. Collection begins during
application drafting, before submission for organizer review.

Required application information includes identity/contact details, birth date
for the minimum age of 19, emergency contacts, Outreach team selection, training
and experience choices, referral, motivation, and Code of Conduct acknowledgement.
Medic applicants supply certification and expiry details. Middle names, preferred
name, pronouns, medical information, and additional team interests are optional.
Selecting a sensitive lived-experience choice is optional. Applicants are asked
to inform their emergency contact and obtain agreement before providing details.

Code of Conduct acknowledgement records a version and time; it does not authorize
unrelated uses of personal information. New submissions preserve the original
answers and account email separately from later profile changes.

## Drafts and browser storage

- Explain account and browser autosave before the application form.
- Keep drafts out of organizer views. Submitting makes the profile available for
  authorized organizer review.
- Successful submission removes the account draft and the current browser's copy.
- Discard removes unsubmitted account/browser draft answers, with clear failure
  or retry feedback. It does not delete the account or a submitted application.
- Other tabs/devices must not silently restore discarded answers. Answer-free
  discard markers may remain for that protection.
- Signing out clears synced browser draft copies but preserves unsynced backups;
  it does not delete the account draft. Offline device copies need separate handling.
- Authentication cookies and browser draft storage are separate. Sessions are
  configured for 30 days and renew with use.

## Access and disclosure

Volunteers can view their own account and captured original submission. Authorized
active organizers with completed applications can review full profiles, including
emergency, medical, and training answers. Full-profile views and profile edits are
audited; edit logs record changed fields rather than copied answers. Two-factor
authentication is optional, and required at sign-in once enabled.

Roster visibility currently differs from the policy wording: eligible volunteers
can see limited rosters in the application. Resolve that discrepancy through
[Privacy planning](/planning/privacy/#policy-and-code-discrepancies) before treating
organizer-only roster visibility as an enforced requirement.

Provider disclosures cover Cloudflare hosting/storage, Resend delivery and
notification content, and consented Discord identity/membership and managed roles.
Discord does not receive volunteer profile answers. Public third-party images and
outbound donation/social links are also described. Live provider settings and
organizational procedures need evidence beyond this specification.

## Account deletion

Self-service deletion of a **sign-in account** requires a sign-in within ten minutes,
confirmation of the current email, and explicit consent to deletion. It:

- ends sessions and removes sign-in credentials, authenticator records, and drafts;
- replaces the sign-in identity, cancels upcoming sign-ups, and stops pending
  notifications, with limitations for messages already sent or sending;
- retains minimal Discord identity/sync state until managed roles are removed;
  Discord membership and unrelated roles are preserved;
- hides the deleted account from volunteer management and profile views;
- retains submitted applications, profile and decision history, and delivery
  records for separate retention handling.

Signing in with the former email creates a new account and does not restore the
old application or approvals. Further removal requests are handled by the Privacy
officer. Browser copies, provider systems, recipient inboxes, and backups require
separate attention.

## Retention rules

These periods are documented in the current public policy. They are administered
by **manual reviews and deletion**, with no general automated retention cleanup.

| Information                                                        | Documented rule                                                                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsubmitted draft answers                                          | Delete after 30 days without an answer edit; offline browser copies need separate handling.                                                                          |
| Accounts without a submitted application                           | Delete after 90 days without sign-in; the shorter draft-answer period still applies.                                                                                 |
| Volunteer profiles                                                 | Keep for active participation. Review after 24 months without sign-in or event participation; give 30 days' notice before deleting an inactive profile.              |
| Event, registration, profile-view, edit, and access-change records | Normally retain identifiable records for 12 months after the event/action. Preserve minimum current orientation/eligibility records while needed for participation.  |
| Information used for a decision directly affecting a person        | Retain the information actually used for at least one year after each use, with justified longer retention and legal holds where applicable.                         |
| Authentication records                                             | Keep while needed for sign-in, security, abuse prevention, or an investigation. Expired verification records and abuse counters have bounded sign-in housekeeping.   |
| Notification content and delivery history                          | Review for deletion when no longer needed for delivery, safe retries, investigations, or required decision records; minimal duplicate-prevention records may remain. |

Provider windows are separate from application retention. A restore must account
for prior deletions. Account deletion does not promise immediate or universal
erasure, and original snapshots do not capture every later decision's evidence.

## Requests and accountability

The policy names the **Privacy officer** role at After Hours Outreach Society and
publishes `info@afterhoursoutreach.ca` for access, correction, deletion,
consent-withdrawal, and complaint requests. It describes identity verification,
manual request/response records, permitted response extensions, no access fees for
volunteer employee information, and escalation to BC's privacy commissioner.

Ongoing profile details can be edited; email changes use verification. Birth date
and the original submission need separate correction handling. The policy's
additional claim about uneditable legal names conflicts with the current profile
editor and is tracked in [Planning](/planning/privacy/#policy-and-code-discrepancies).

Material policy changes are to be published and notified by email before taking
effect, with fresh consent where required for a new purpose. The repository
contains the policy commitments; staffing, approvals, completed reviews, and
request handling require separate organizational evidence.
