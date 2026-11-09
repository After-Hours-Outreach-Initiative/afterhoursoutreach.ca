---
title: Discord
description: Consented account linking, verified server membership, and managed-role rules.
---

Discord connects a website account to the After Hours Outreach community server.
Email remains the sign-in method. Discord roles follow website eligibility;
assigning a role in Discord does not grant website access.

Bot setup, OAuth mechanics, synchronization, and recovery procedures live in
[Discord implementation](/implementation/discord/).

## Connection workflow

**Planned requirement:** the application currently pauses Discord as a completion
requirement. Form submission and Naloxone confirmation allow entry into review.
The connection rules below describe the intended step when resumed; integration
code remains present. See the [current implementation review](/implementation/privacy/#email-and-discord-data).

New applicants submit the application form, confirm Naloxone 101 completion,
connect Discord, then await organizer review.

1. The applicant consents on the website and in Discord to identity access and
   joining the After Hours Outreach server.
2. The website links the authorized Discord identity.
3. Full server membership must be verified before the application step completes.
   A successful link alone is insufficient.
4. If the server requires Membership Screening, the person accepts the rules in
   Discord. Role assignment must not bypass screening.

Existing submitted profiles are exempt from the linking requirement and keep
website access without connecting. They may connect from **Account settings**,
under **Discord**, without supplying invented historical course-completion dates.
Unsubmitted accounts become new applicants when they submit.

## Identity and consent

- One Discord identity can belong to only one website account.
- An account cannot silently switch to another Discord identity.
- Linking does not merge accounts by email or provide Discord sign-in.
- Consent covers joining for that authorization attempt. Leaving the server does
  not authorize automatic rejoining later; reconnecting requires fresh consent
  for the same identity.
- Correction and consent withdrawal require an authorized recovery process that
  preserves pending role-removal obligations. See
  [Security and account recovery](/implementation/discord/#security-and-account-recovery).

## Managed roles

All three roles require a submitted profile, an **active, application-approved**
website account, a link, and verified full Discord membership.

| Role      | Additional requirement                           |
| --------- | ------------------------------------------------ |
| Volunteer | None                                             |
| Organizer | Website organizer status                         |
| Medic     | Medic team selected and manually patrol approved |

There is no Outreach or separate patrol-approved role. Organizer status does not
bypass active-account or application-approval requirements for Discord.
Certification expiry is not an additional Discord-role eligibility condition.
Orientation attendance does not change role eligibility.

Deactivation or revoked application approval removes all managed roles.
Reactivation, restored approval, team edits, and website role changes reconcile
the roles to current eligibility. Manually changing a managed role in Discord
does not override these rules; synchronization corrects drift.

Unrelated roles, nicknames, channels, messages, and server membership are preserved.
The integration never kicks or bans a member.

## Connection status

The application tracker, account settings, and authorized organizer review show
connection and synchronization status. Linked identity, verified membership,
and synchronized roles are distinct milestones. Pending and failed work remains
visible so the person or organizer can follow up.
