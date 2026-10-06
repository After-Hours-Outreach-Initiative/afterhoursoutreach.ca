# Privacy

How the site meets BC's Personal Information Protection Act (PIPA). GDPR does
not apply, since the society is not in the EU and does not target people there.

## What PIPA asks for

- Tell people why each piece of information is collected, when it is collected.
- Get consent. Submitting the form after reading the notice counts.
- Only collect what is needed.
- Protect it.
- Let people see and correct their information.
- Keep information used to make a decision about someone for at least 1 year
  after the decision, then delete what is no longer needed.
- Name a privacy officer.

## Privacy page

A `/privacy` page, linked from the footer and the registration form, covering:

- What is collected and why.
- The Discord user id and display name saved when someone optionally connects
  their Discord account.
- Who can see it: the volunteer and organizers.
- That it is stored in the US, on Cloudflare, and that emails are sent through
  Resend, also in the US.
- The session cookie, and that there are no tracking cookies.
- How long it is kept.
- How to see, correct, or delete your information.
- How to contact the privacy officer.

## Safeguards

- Sensitive fields are only shown to organizers, and only after they set up two
  factor.
- Every profile view by an organizer is logged.
- No third party scripts or trackers on account pages.

## Deleting an account

A volunteer can delete their account from `/volunteer/account`. This removes
their operational profile and signups, subject to the retention policy approved
before launch.

## Retention and deletion proposal

For board and privacy-officer review, not an approved policy or an implemented
purge schedule. The one-year decision-record minimum comes from
[PIPA section 35](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01#section35).
These are proposed maximum periods unless continued retention is required for a
documented legal or operational purpose.

| Information                                                                              | Proposed retention                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified accounts without registration                                                   | Delete after 90 days without sign-in.                                                                                                                                                                                         |
| Active volunteer profiles                                                                | Keep while the volunteer participates. Review after 24 months without sign-in or event participation; give 30 days' notice before deletion.                                                                                   |
| Event signups and orientation attendance                                                 | Keep identifiable records for 12 months after the event, then delete or keep only anonymous totals, unless still needed as a decision record.                                                                                 |
| Information used for approval, denial, or other decisions directly affecting a volunteer | Preserve the information actually used for at least one year after each decision, including the applicable version if the profile later changes. Review and delete when that minimum and any other justified need have ended. |
| Profile-view, edit, role, and approval audit logs                                        | Keep for 12 months, or longer where part of a required decision record or a documented investigation. No medical answers or authentication secrets in logs.                                                                   |
| Email sign-in codes and hashed abuse counters                                            | Codes expire after ten minutes; purge verification records and counters within 24 hours after expiry.                                                                                                                         |
| Sessions and associated IP/device details                                                | Revoke immediately on sign-out or account deletion; purge expired sessions within seven days.                                                                                                                                 |
| Staging accounts and sample profiles                                                     | Use sample profile answers only; delete test accounts within 30 days of last use.                                                                                                                                             |

On a confirmed deletion request, revoke sessions and cancel future signups
immediately. Remove the operational account and profile within 30 days. If
specific decision information must be retained, explain what is kept, why, and
its review date. Restrict it to the privacy officer and authorized review staff;
do not keep the entire profile merely because an approval occurred.

Document any legal hold, its reason, owner, and review date. Deleted data may
remain in backups until those backups expire; restores must reapply deletions
before serving traffic. Confirm Cloudflare backup windows and Resend's email
retention separately before publishing promises about provider-held copies.

Approval is also needed for the privacy contact, restricted decision-record
storage, and scheduled deletion jobs. The current profile-edit audit records
field names only; it does not preserve the information used in past decisions.

## Cookies

No cookie banner is needed. The only cookie is the session cookie, which is
strictly necessary. If analytics are use a cookie-less option, like Cloudflare
Web Analytics.

## Privacy officer

A person the society names as responsible for following PIPA. They handle
requests to see, correct, or delete information, answer privacy questions and
complaints, and lead the response if there is a breach.

## TODO

- TODO: decide if the medical conditions field should be encrypted in the app
  on top of D1's encryption at rest.
- TODO: name the privacy officer.
- TODO: set up a contact address for them, for example
  `privacy@afterhoursoutreach.ca`.
- TODO: decide how long inactive accounts are kept before they are deleted.
- TODO: decide what is kept after an account is deleted, if anything.
- TODO: write a breach plan: who gets told, and how fast.
- TODO: have someone on the board, or a lawyer, read the privacy page before
  launch.
