---
title: Product specification
description: Users, volunteer progression, and the product rules behind the website.
---

The website supports volunteer recruitment and participation in After Hours
Outreach activities. Organizers review applications, manage access, and coordinate
patrols and orientations.

This section records the product baseline from the existing workflow guides.
Unresolved ideas remain in [Planning](/planning/). Agreed additions that are not
built must be marked **Planned**, with a link to their implementation status.
Configuration and deployment readiness are documented in
[Implementation](/implementation/).

## People and access

| Person                    | Main capabilities                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Visitor                   | Read public information and start an application or sign in. Event details are private.  |
| Applicant                 | Complete the application steps and manage their account while awaiting organizer review. |
| Approved volunteer        | View events and book orientations. Patrol booking needs separate patrol approval.        |
| Patrol-approved volunteer | Book eligible patrols; medic places have additional qualification rules.                 |
| Organizer                 | Review applications, manage access and events, and record orientation completion.        |

Applicant and approval milestones describe account progress; the account roles
are Volunteer and Organizer. Role-based access does not replace the separate
active-account, application, patrol, or qualification checks.

## Volunteer journey

1. Sign in by email and complete the application, including the Code of Conduct
   acknowledgement.
2. Confirm Naloxone 101 completion. The Discord application requirement is
   currently paused; the intended linking rules are described separately.
3. Wait for organizer application approval. Account editing remains available;
   events are unavailable until approval.
4. Book an orientation. An organizer records completion after attendance.
5. Receive a separate organizer decision on patrol approval. Orientation completion
   does not automatically grant it, and is not the only possible path to approval.
6. Book patrols and maintain contact and qualification details.

## Specifications

- [Site map](/specification/site-map/): a collapsible tree of current website URLs
  and role badges.
- [Accounts](/specification/accounts/): authentication, applications, profile fields,
  sessions, email changes, and roles.
- [Events](/specification/events/): eligibility, capacity, visibility, sign-ups,
  organizer changes, and attendance.
- [Discord](/specification/discord/): consent, membership, identity linking, and
  managed-role eligibility.
- [Notifications](/specification/notifications/): required account messages,
  organizer email choices, and medic certification reminders.
- [Privacy](/specification/privacy/): collection, access, drafts, account deletion,
  and the policy's manual retention rules.

The current privacy policy is part of the specification baseline.
[Privacy planning](/planning/privacy/) records wording/code discrepancies and
operational evidence to confirm. The [Privacy implementation review](/implementation/privacy/)
explains the code behind the documented rules.
