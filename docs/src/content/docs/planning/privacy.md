---
title: Privacy planning
description: Remaining privacy decisions, policy and code discrepancies, and operational evidence to confirm.
---

Reviewed against the repository on **November 9, 2026**. The earlier October 15
review was stale: much of its proposed work is already implemented or documented
in the application's privacy policy, which has an effective date of October 27, 2026. It no longer describes itself as an unfinished draft.

The [Privacy specification](/specification/privacy/) records the current policy
baseline. The [Implementation review](/implementation/privacy/) explains what
the code enforces. This page tracks remaining discrepancies, decisions, and
evidence that cannot be established by reading code.

## Work already present

Checked items mean the stated code or policy text exists. They do not establish
that a manual organizational procedure has been performed.

- [x] Privacy policy with the Society's name, website/portal scope, effective date,
      collection purposes, required/optional fields, access, providers, requests,
      retention rules, and change-notification commitments.
- [x] Application notice explaining account and browser autosave before the form.
- [x] Draft discard with server-side removal, browser cleanup, retry feedback, and
      protection against stale tabs restoring discarded answers.
- [x] Original application snapshots and versioned Code of Conduct acknowledgement
      preserved separately from later profile edits.
- [x] Self-service sign-in-account deletion with recent sign-in, email confirmation,
      session/credential removal, draft cleanup, future-sign-up cancellation, and
      notification/Discord cleanup. Retained volunteer records are explained.
- [x] Published Privacy officer role and `info@afterhoursoutreach.ca` contact, with
      written request, correction, complaint, and consent-withdrawal procedures.
- [x] Published retention schedule administered by manual reviews and deletion,
      including a separate 30-day draft-answer period.
- [x] Role-checked profile access, profile-view/edit auditing, optional two-factor
      authentication, and bounded expired verification/abuse-counter cleanup.

The old instructions to create a policy, add draft discard, add account deletion,
choose a contact address, and invent a retention schedule should not remain
unchecked launch tasks.

## Policy and code discrepancies

These are concrete reconciliation tasks found during the review. The public
policy and application code were not changed by this documentation audit.

| Area                          | Policy text in the repository                                                 | Current code                                                                                                                                                               | Remaining work                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Event rosters                 | Says rosters are organizer-only and other volunteers do not see roster names. | Eligible volunteers can see limited upcoming-event rosters with display names, category, and medic mark. Private profile fields and internal account IDs are not returned. | Agree the intended visibility and align the policy with the application.               |
| Legal-name corrections        | Says legal names cannot be changed through the profile editor.                | Name fields remain editable; the profile read-only field list contains only birth date. The original submission remains unchanged.                                         | Reconcile the wording or change the editing rule through an explicit product decision. |
| Organizer notification timing | Says first application submissions automatically queue organizer email.       | The current outbox is written when Naloxone confirmation completes the application's entry into review, not on the initial form save.                                      | Describe the actual review-ready trigger and its minimal disclosure accurately.        |

Evidence: [privacy policy source](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/pages/privacy.astro),
[limited roster query](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/db/events.ts),
[profile fields](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/data/application.ts), and
[submission outbox](https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca/blob/main/src/server/db/submission-notifications.ts).

## Collection and notice follow-up

The application already explains autosave before its questions, and the full
policy describes browser copies, account drafts, discard, and the manual retention
period. The ordinary sign-in panel explains account creation and minimum age but
has no inline privacy-policy link or collection-purpose notice of its own; the
shared footer supplies a policy link. Review whether to put a concise notice
beside the email form. This is narrower than the old claim that the whole
application lacks an upfront notice.

The policy now explains why full birth dates and emergency contacts are collected,
identifies medical and lived-experience information as optional, and asks applicants
to tell their emergency contact and obtain agreement. Decisions to collect less
information, exclude sensitive answers from browser backups, or restrict fields
to particular organizers would be further product changes. Record their rationale
and requirements if adopted; do not imply the existing disclosures are absent.

## Retention and deletion follow-up

The schedule has moved from an old proposal into the current policy. See
[Retention rules](/specification/privacy/#retention-rules) for its periods.
There is **no general automated retention cleanup**; the policy explicitly assigns
manual reviews and deletion to the Privacy officer. Adding scheduled purge jobs
would change that operating model and is not an already-agreed requirement.

Remaining implementation/operations questions:

- Record how manual reviews identify inactive drafts, accounts, profiles, event
  records, audit entries, notification content, and relevant provider copies.
- Preserve the information actually used for later approval/access decisions.
  Original submissions and field-name audit logs exist, but do not capture a full
  answer snapshot at every later decision. Establish how supporting decision
  records and legal holds are retained and reviewed.
- Document further erasure of retained volunteer records after sign-in-account
  deletion. The self-service action is implemented; it deliberately retains
  submitted profiles, applications, and history for separate retention handling.
- Retain evidence that restores account for prior deletions and that offline
  browser copies, provider records, inboxes, and backups are handled separately.

These are workflow and evidence questions, not proof that no manual process has
been carried out.

## Operational evidence to confirm

The repository states that the Privacy officer monitors the published inbox,
handles requests, and administers manual retention. It does not contain evidence
of staffing, completed request responses, training, retention reviews, breach
exercises, or formal organizational/legal approvals. Confirm what has already
been done and record the owner and evidence rather than marking all of it undone.

The policy also records provider locations, tracking settings, and retention
windows. This audit checked source, not live Cloudflare/Resend accounts or
provider agreements. Keep the verification date and evidence for those claims
and review them when deployment or provider settings change.

## Legal reference

BC PIPA remains the reference for accountability, collection notices, appropriate
consent or other authority, access/correction, safeguards, and retention. Its
[section 35](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01#section35)
requires at least one year of retention for information used to make a decision
directly affecting a person. The source policy already describes this minimum;
it is separate from proving that each decision's supporting records are retained.

Use the [OIPC guidance library](https://www.oipc.bc.ca/resources/guidance-documents/)
and [private-organization resources](https://www.oipc.bc.ca/for-private-organizations/)
when reviewing procedures or revising the policy. A code review does not establish
completion of organizational approvals or procedures.
