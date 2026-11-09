---
title: Plans and open decisions
description: Deferred work, unresolved product questions, and launch preparation.
---

These items come from the existing guides. They are proposals or unresolved
decisions, with no new priority or delivery date assigned by this reorganization.
The [Specification](/specification/) records the product baseline; technical
procedures belong in [Implementation](/implementation/).

## Applications and qualifications

Related specification: [Accounts](/specification/accounts/).

- Decide whether medical certifications need independent verification, such as a
  licence number or certificate image, and who would review them. Uploads need
  storage, access, and privacy decisions before implementation.
- Decide whether applying requires a separate waiver in addition to the Code of
  Conduct acknowledgement.
- Define whether volunteer hours should be tracked, what counts, and who can
  correct or approve entries. Hours tracking remains deferred.
- Review inherited form-option wording. The earlier TODO listed “Nalaxone”,
  “wiith”, “Pa:ramedic”, “relatons”, “opiod”, and “ventiliation”; check which still
  need correction before treating that list as current work.

Medic certification reminder behavior already has a
[specification](/specification/notifications/#medic-certification-reminders) and
[implementation](/implementation/notifications/#medic-certification-reminders).
It is separate from deciding how to verify certificates or accept uploads.

## Event history and retention

Related specification: [Events](/specification/events/).

- Agree how long cancelled sign-ups, past events, and identifiable rosters should
  remain. Coordinate this with the proposed
  [documented retention schedule](/specification/privacy/#retention-rules).
- Decide which past events volunteers and organizers should be able to browse,
  and for how long. Any visitor-facing history needs an explicit privacy and
  visibility decision.
- Decide whether volunteers who have completed orientation should continue to
  see upcoming orientations. The current rules allow multiple orientation bookings.

These questions concern future retention and presentation. Existing cancellation
and attendance mechanisms are described in
[Event implementation](/implementation/events/).

## Privacy and launch preparation

The [Privacy specification](/specification/privacy/) records the current policy,
published contact and manual retention rules. Autosave notices, draft discard,
original submission snapshots, and sign-in-account deletion already exist.
[Privacy planning](/planning/privacy/) tracks specific policy/code discrepancies
and operational evidence to confirm, without assuming organizational work is undone.

Production database provisioning and integration configuration are tracked through
the [architecture](/implementation/system-architecture/#environment-boundaries)
and [deployment guide](/implementation/deployment/). Configuration state belongs
there rather than in product requirements.

## Backups and recovery

Decide whether provider recovery features are sufficient or whether periodic
database exports are also needed. Agree who can access backups, where they are
stored, how long they remain, and how deletions are reapplied after restoration.
The earlier backend TODO has not established a backup policy.

## Documentation reconciliation

The existing guides contained conflicting or outdated descriptions. Resolve these
against the current application before making new product commitments:

- Email changes: account settings now provide new-address code verification, while
  older guides described a confirmation link or said the feature was unimplemented.
  The [Accounts specification](/specification/accounts/#changing-email) uses the
  current verification flow; the former old-address notification claim still
  needs a product decision and implementation check.
- Privacy and deletion: the [implementation review](/implementation/privacy/)
  was refreshed against current code on November 9, 2026. Remaining policy/code
  discrepancies concern roster visibility, editable names, and organizer
  notification timing; see [Privacy planning](/planning/privacy/#policy-and-code-discrepancies).

## Moving a proposal forward

Describe the problem, the behavior being proposed, alternatives, and decisions
still needed. Once agreed, put the requirements in the relevant specification
page and mark unbuilt behavior as **Planned**. Keep sequencing and remaining work
here, linking to the specification. Implementation notes then describe how that
behavior is delivered.
