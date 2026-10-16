# Privacy

Implementation notes, proposed policies, and pre-launch privacy work for the
website. Reviewed against the current implementation on October 15, 2026.

This is not an approved privacy policy or a legal compliance certification.
The public page at [`/privacy`](../src/pages/privacy.astro) is still a draft and
asks people to use sample profile answers until the policy is finalized. Do not
treat the site as ready to collect real volunteer data until the policy and
supporting procedures have been reviewed and implemented.

## Legal starting point

BC's Personal Information Protection Act (PIPA) is the main starting point for
a BC nonprofit's handling of personal information. Confirm whether other laws
apply to the society's actual activities; being outside the EU alone does not
exclude GDPR, for example.

PIPA includes volunteers in its definition of employees. Some information used
to establish, manage, or end a volunteer relationship may qualify as employee
personal information. Review the specific notification and reasonableness
requirements in sections 13, 16, and 19 rather than assuming everything depends
on blanket consent. Those provisions do not authorize unrelated collection or
unrestricted organizer access.

## What PIPA asks for

- Name a privacy officer and make their title and contact information public.
- Explain collection purposes before or at collection, not just at submission.
- Obtain appropriate, meaningful consent unless PIPA authorizes the activity
  without consent. The appropriate form depends on sensitivity and context;
  submitting a form is not automatically sufficient for every use or disclosure.
- Limit collection, use, and disclosure to reasonable, appropriate purposes.
- Protect information with safeguards appropriate to its sensitivity.
- Provide access, correction, and complaint procedures.
- Retain information actually used for a decision directly affecting someone for
  at least one year after using it. Securely destroy or anonymize information
  once it no longer serves its collection purpose and is no longer needed for
  legal or business purposes, subject to that minimum.
- Develop and follow internal privacy practices as well as a public policy.

## Current implementation

- Email identifies an account. Hosted sign-in and event/access notifications use
  Resend; local development simulates email delivery.
- Accounts, profiles, application drafts, event registrations, attendance,
  approval/access changes, and notification records are saved in Cloudflare D1.
- Sessions include IP address and user-agent information. Authentication also
  stores verification records, two-factor setup information, and abuse counters.
- Unsubmitted application answers, including medical answers, are backed up in
  browser local storage and automatically saved to the account. Drafts are not
  exposed through organizer views. Successful submission removes draft copies;
  sign-out clears synced browser copies, but unsynced browser backups remain.
- Authorized active organizers with completed applications can view full
  profiles. Two-factor authentication is optional for organizers and volunteers;
  once enabled, it is required at sign-in. It is not currently a prerequisite
  for organizer access to sensitive information.
- Organizer full-profile views and profile edits are logged. Edit logs record
  field names, not copies of the answers. Event rosters contain names rather
  than medical or emergency-contact answers; the public policy must also explain
  who can see roster names.
- Volunteers can edit ongoing profile answers at `/volunteer/account`, but there
  is no self-service account deletion flow. Do not describe one as available.
- Discord account linking is deferred, not an implemented collection practice.
- The retention schedule below is a proposal, not an implemented purge schedule.

## Privacy page

Keep `/privacy` accessible without an account and linked from the footer. Add a
short notice and policy link before collection in the sign-in and application
flows. A footer link alone does not explain unexpected collection such as
autosaving medical answers before submission.

Before publishing the final policy, cover:

- The society's legal name, the policy's scope, effective date, privacy officer's
  title, and a working contact address.
- The information collected and the specific purpose for each category:
  identity/contact details; age eligibility; emergency contacts; qualifications
  and training; optional medical and lived-experience answers; application and
  Code of Conduct records; event attendance and access decisions; and technical,
  authentication, security, and notification records.
- Which answers are required or optional, why they are needed, how they affect
  participation, and whether they are used in approval decisions.
- When collection starts, how consent is obtained where required, how to
  withdraw it, and any consequences or legal limitations. Code of Conduct
  acknowledgement is not a substitute for privacy notice or consent.
- Who can access each category, including volunteers, organizers, operational
  administrators, and service providers, and the limits on their use.
- What Cloudflare and Resend receive, why, and where information may be stored
  or processed. Verify deployed storage settings, provider contracts,
  subprocessors, support access, and backup arrangements before making country
  promises. The current public draft's US-storage statement needs verification;
  it is not evidence that all processing is confined to the US.
- Relevant emergency and legally authorized disclosures, described narrowly
  rather than as permission for unrestricted sharing.
- Approved retention periods or clear criteria, deletion-request steps,
  necessary retention exceptions, and backup expiry limitations.
- How people request access, corrections, or a privacy investigation, and how
  they can escalate a concern to BC's Office of the Information and Privacy
  Commissioner (OIPC).
- A plain-language summary of actual safeguards, cookies, browser storage, and
  third-party requests. Do not promise absolute security.
- How significant policy changes will be communicated and when fresh consent
  will be obtained where required.

Define whether this is an organization-wide policy or a website policy backed
by other policies. Inventory any external Google Forms, donations, Discord,
photos, email correspondence, and offline records actually used by the society.
Explain the society's own handling and relevant third-party services; linking
to a provider's policy does not replace the society's responsibilities. Do not
describe deferred features as if they already collect information.

## Collection and sensitive information

Review necessity before improving the wording. Optional collection can still
be excessive or inappropriate.

- Consider whether verifying that an applicant is at least 19 requires retaining
  their full birth date, or whether a less detailed eligibility record would do.
- Review whether the medical-conditions free-text field is needed, whether it
  can be narrowed to practical event-safety needs, and which organizers need it.
- Treat the training choice about DTES, substance-use, or recovery lived
  experience as potentially sensitive, not merely a qualification. Decide
  whether to collect it at all and make its optional nature and use clear.
- Review the notice and authority for collecting another person's emergency
  contact details. Consider asking applicants to tell that person and obtain
  their agreement, without assuming the applicant's consent alone settles this.
- Use an appropriate express-consent process for sensitive information where
  consent is the basis for collection, use, or disclosure. Separate optional
  purposes from information necessary to manage volunteering.

### Autosaved applications

The application currently has no upfront explanation of autosaving before its
questions. Its review step says nothing has been submitted yet, although draft
answers may already be stored. Distinguish submission for organizer review from
storage in the browser and account.

Before autosaving begins, explain what is saved, where it is saved, who can
access it, how long abandoned drafts remain, and how to clear them. Review
whether sensitive answers should be excluded from browser backups or require
an explicit choice before storage. Provide a safe way to discard a draft and
address unsynced copies on shared devices; do not rely only on a warning buried
in the privacy policy.

## Access, correction, deletion, and complaints

Publish a working request channel and establish an internal process to:

- Accept written access and correction requests and reasonably verify identity
  without collecting excessive additional information.
- Search information under the society's control, including relevant drafts,
  logs, notification records, and provider-held records, not only profile fields.
- Explain how information has been used and to whom it has been disclosed, as
  required by PIPA. Protect other people's information when responding.
- Respond generally within 30 business days, subject to PIPA's permitted
  extensions and other applicable provisions. Explain an extension or refusal
  and the person's review or complaint options.
- Correct errors or annotate a requested correction that is not made, and notify
  other organizations of corrections where required. Self-service profile edits
  do not replace the full correction-request process.
- Handle consent withdrawals and deletion requests with an explanation of any
  consequences and retained records. Do not promise an unconditional right to
  immediate deletion or an account-deletion button that does not exist.
- Investigate complaints and explain how to contact the OIPC if unresolved.

PIPA prohibits access fees for employee personal information. Review that rule
for volunteer records before introducing any request fee.

## Safeguards

Current safeguards include authenticated, role-checked access, organizer
profile-view and edit auditing, and restrictions on third-party resources on
account pages. These are not a complete privacy management program.

Recommended pre-launch work:

- Limit sensitive fields to staff who need them rather than granting every
  organizer identical access. Review developer and provider-console access too.
- Train organizers on confidentiality, shared devices, exports, screenshots,
  emailed reasons, and avoiding sensitive information in notifications or logs.
- Assess additional application-level encryption for sensitive fields, including
  key management. Encryption does not replace minimization or access controls.
- Review provider agreements, security, deletion support, retention, backups,
  and overseas processing. Document the conclusions.
- Write a breach-response procedure: responsibilities, containment, risk
  assessment, applicable notification duties, communications, and follow-up.
- Test access restrictions, request handling, deletion, and backup restoration.

Requiring organizer two-factor authentication may be considered in the future.
It remains optional and is not a launch requirement or a prerequisite for
organizer access to sensitive information.

## Retention and deletion proposal

For board and privacy-officer review, not an approved policy or an implemented
purge schedule. The one-year decision-record minimum comes from
[PIPA section 35](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01#section35).
These are proposed maximum periods unless continued retention is required for a
documented legal or operational purpose.

| Information                                                                              | Proposed retention                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verified accounts without an application                                                 | Delete after 90 days without sign-in.                                                                                                                                                                                                      |
| Active volunteer profiles                                                                | Keep while the volunteer participates. Review after 24 months without sign-in or event participation; give 30 days' notice before deletion.                                                                                                |
| Event signups and orientation attendance                                                 | Keep identifiable records for 12 months after the event, then delete or keep only anonymous totals, unless still needed as a decision record.                                                                                              |
| Information used for approval, denial, or other decisions directly affecting a volunteer | Preserve the information actually used for at least one year after using it for each decision, including the applicable version if the profile later changes. Review and delete when that minimum and any other justified need have ended. |
| Profile-view, edit, role, and approval audit logs                                        | Keep for 12 months, or longer where part of a required decision record or a documented investigation. No medical answers or authentication secrets in logs.                                                                                |
| Email sign-in codes and hashed abuse counters                                            | Codes expire after ten minutes; purge verification records and counters within 24 hours after expiry.                                                                                                                                      |
| Sessions and associated IP/device details                                                | Revoke the current session immediately on sign-out and all sessions on account deletion; purge expired sessions within seven days.                                                                                                         |
| Staging accounts and sample profiles                                                     | Use sample profile answers only; delete test accounts within 30 days of last use.                                                                                                                                                          |

Also approve explicit periods and deletion mechanisms for abandoned account and
browser drafts, notification subjects/bodies and delivery records, infrastructure
logs, authentication setup information, and provider-held copies. The 90-day
account proposal must not silently become the default for sensitive drafts.

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

Authentication uses necessary cookies, including session and two-factor flow
cookies; do not claim the session cookie is the only one. Configured sessions
last 30 days and renew with use. Browser local storage also holds application
drafts and needs disclosure even though it is not a cookie.

Verify cookies, third-party requests, and any dashboard-injected analytics in
the deployed site before deciding whether additional consent controls or a
banner are needed. Public pages currently request some donation images from
Shopify's CDN, which is relevant third-party contact even without a tracking
script. A cookie-less analytics product is not automatically outside privacy
obligations; assess its actual collection and processing before adding it.

## Privacy officer

A person the society names as responsible for following PIPA. They handle
requests to see, correct, or delete information, answer privacy questions and
complaints, and lead the response if there is a breach.

Designate a responsible person and set up a monitored address, for example
`privacy@afterhoursoutreach.ca`, before publishing it as a contact. Assign a
backup and give them authority and resources to handle requests on time.

## Pre-launch checklist

- [ ] Designate the privacy officer and confirm the request/complaint channel.
- [ ] Complete a personal-information inventory and the OIPC privacy impact
      assessment, including each field's purpose, sensitivity, access, recipients,
      storage, authority or consent, and retention.
- [ ] Decide whether to remove or narrow birth-date, medical, and sensitive
      lived-experience collection; approve appropriate notices and consent flows.
- [ ] Explain autosave before collection, review sensitive browser storage, and
      implement draft-discard and abandoned-draft deletion rules.
- [ ] Approve organizer access restrictions, training, and any additional
      encryption.
- [ ] Verify providers, processing locations, agreements, retention, and backups.
- [ ] Approve the retention schedule, restricted decision-record storage, legal
      hold procedure, and deletion jobs; test that they work.
- [ ] Establish and test access, correction, consent-withdrawal, deletion, and
      complaint handling, plus the breach-response procedure.
- [ ] Reconcile this document, the public policy, and the actual implementation;
      include organization-wide activities where applicable.
- [ ] Obtain board/privacy-officer approval and a BC privacy lawyer's review of
      both the policy and collection flows before using real volunteer data.
- [ ] Assign an ongoing review owner and review whenever collection, providers,
      access, or purposes change.

## Resources

Start with BC-specific official guidance rather than a generic policy generator.
These resources help identify gaps but do not certify compliance.

- [BC Personal Information Protection Act](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01):
  the legislation, including accountability, notice, access, safeguards, and
  retention requirements.
- [OIPC: Developing a privacy policy under PIPA](https://www.oipc.bc.ca/documents/guidance-documents/2164):
  the drafting checklist for the public policy and supporting practices.
- [OIPC: Privacy impact assessment template for organizations](https://www.oipc.bc.ca/documents/guidance-documents/2245)
  and [private-sector PIA guidance](https://www.oipc.bc.ca/documents/guidance-documents/2246):
  map the data, purposes, access, providers, risks, and mitigations before launch.
- [OIPC: Obtaining meaningful consent](https://www.oipc.bc.ca/documents/guidance-documents/2134):
  particularly relevant to sensitive answers and collection before submission.
- [OIPC: Resources for private organizations](https://www.oipc.bc.ca/for-private-organizations/):
  PIPA guidance, privacy management, cloud computing, and security self-assessment.
- [OIPC: Privacy breach quick reference guide for small and medium-sized businesses](https://www.oipc.bc.ca/documents/guidance-documents/3134):
  use when preparing the breach-response procedure.
- [Law for Non-Profits](https://lawfornonprofits.ca/): free nonprofit-focused
  legal information and privacy tools, not a substitute for advice on the
  society's specific practices.
