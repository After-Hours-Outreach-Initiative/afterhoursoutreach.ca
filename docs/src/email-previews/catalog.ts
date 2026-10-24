import {
  accessRegistrationCancelledEmail,
  applicationSubmittedEmail,
  emailSenders,
  eventCancelledEmail,
  eventChangedEmail,
  eventNotificationEmail,
  medicCertificationEmail,
  patrolSeriesChangedEmail,
  patrolSeriesShortenedEmail,
  patrolSeriesStoppedEmail,
  registrationChangedEmail,
  roleChangedEmail,
  signInEmailContent,
  volunteerAccessEmail,
  type EmailContent,
  type EmailEvent,
} from "../../../src/data/email-templates";

export interface EmailExample extends EmailContent {
  name: string;
  from: string;
  to: string;
}

export interface EmailPreview {
  id: string;
  name: string;
  group: string;
  trigger: string;
  delivery: string;
  source: string;
  examples: EmailExample[];
}

// Never load users, queued messages, credentials or live auth proofs for previews.
const origin = "https://preview.example.invalid";
const recipient = "volunteer@example.invalid";
const reason = "The meeting location is unavailable this week.";
const source = {
  auth: "src/server/auth/services.ts",
  volunteers: "src/server/db/volunteers.ts",
  events: "src/server/db/events.ts",
  patrols: "src/server/db/patrol-series.ts",
  submission: "src/server/db/submission-notifications.ts",
  medic: "src/server/medic-certifications.ts",
};
const optionalDelivery =
  'Only sent when an organizer chooses "Save and send email". The saved change itself does not depend on email delivery.';

function example(
  name: string,
  content: EmailContent,
  account = false,
  to = recipient,
): EmailExample {
  return {
    name,
    from: account ? emailSenders.accounts : emailSenders.notifications,
    to,
    ...content,
  };
}

function notification(name: string, content: EmailContent) {
  return example(name, eventNotificationEmail(content, origin));
}

const events: { name: string; event: EmailEvent }[] = [
  {
    name: "Patrol",
    event: {
      type: "patrol",
      includesOrientation: 0,
      startsAt: Date.parse("2026-11-07T03:00:00Z"),
      meetingPoint: "Sample community centre, main entrance",
    },
  },
  {
    name: "Patrol with orientation",
    event: {
      type: "patrol",
      includesOrientation: 1,
      startsAt: Date.parse("2026-11-14T02:30:00Z"),
      meetingPoint: "Sample outreach hub, welcome desk",
    },
  },
];
const reasons = [
  { name: "without a reason", value: "" },
  { name: "with a reason", value: reason },
];

export const emailPreviews: EmailPreview[] = [
  {
    id: "sign-in",
    name: "Sign-in link and code",
    group: "Accounts",
    trigger: "Someone requests a passwordless sign-in email.",
    delivery:
      "Contains a one-use link and code that expire after ten minutes. The example code and link are not valid credentials.",
    source: source.auth,
    examples: [
      example(
        "Sign-in email",
        signInEmailContent({
          code: "123456",
          url: `${origin}/volunteer/sign-in/complete#${new URLSearchParams({
            email: recipient,
            otp: "123456",
            activation: "preview-only-not-a-real-token",
            returnTo: "/volunteer",
          })}`,
        }),
        true,
      ),
    ],
  },
  {
    id: "change-email",
    name: "Confirm email change",
    group: "Accounts",
    trigger: "A signed-in volunteer requests a change to their email address.",
    delivery:
      "Sent to the proposed new address. The address does not change until the one-use code is confirmed in account settings.",
    source: source.auth,
    examples: [
      example(
        "New address confirmation",
        signInEmailContent({
          code: "654321",
          url: "",
          purpose: "change-email",
        }),
        true,
        "new-address@example.invalid",
      ),
    ],
  },
  {
    id: "application-submitted",
    name: "New application submitted",
    group: "Applications and access",
    trigger: "A volunteer submits their application for the first time.",
    delivery:
      "A separate message goes to each configured reviewer. Uses the preferred name, falling back to the full name. Review requires organizer authorization. Production only; simulated locally and suppressed in branch previews.",
    source: source.submission,
    examples: ["Sam", "Sample Middle Volunteer"].map((applicant, index) =>
      example(
        index ? "Full name fallback" : "Preferred name",
        applicationSubmittedEmail({
          applicant,
          submittedAt: "2026-10-23T18:30:00.000Z",
          reviewUrl: `${origin}/manage/volunteers/sample-applicant`,
        }),
        false,
        "organizer@example.invalid",
      ),
    ),
  },
  {
    id: "application-approved",
    name: "Application approved",
    group: "Applications and access",
    trigger: "An organizer approves a previously unapproved application.",
    delivery: optionalDelivery,
    source: source.volunteers,
    examples: [
      {
        name: "Orientation still required",
        active: true,
        patrolApproved: false,
      },
      {
        name: "Patrol access already approved",
        active: true,
        patrolApproved: true,
      },
      { name: "Account is inactive", active: false, patrolApproved: false },
    ].map(({ name, ...status }) =>
      notification(
        name,
        volunteerAccessEmail(
          {
            ...status,
            applicationApproved: true,
          },
          true,
        ),
      ),
    ),
  },
  {
    id: "application-revoked",
    name: "Application approval revoked",
    group: "Applications and access",
    trigger: "An organizer revokes application approval.",
    delivery: optionalDelivery,
    source: source.volunteers,
    examples: [true, false].map((active) =>
      notification(
        active ? "Account remains active" : "Account is inactive",
        volunteerAccessEmail(
          { active, applicationApproved: false, patrolApproved: false },
          true,
        ),
      ),
    ),
  },
  {
    id: "volunteer-access",
    name: "Volunteer access changed",
    group: "Applications and access",
    trigger:
      "An organizer changes active status or patrol approval without changing application approval.",
    delivery: optionalDelivery,
    source: source.volunteers,
    examples: [true, false].flatMap((active) =>
      [true, false].flatMap((applicationApproved) =>
        [true, false].map((patrolApproved) =>
          notification(
            `${active ? "Active" : "Inactive"}, application ${applicationApproved ? "approved" : "pending"}, patrol ${patrolApproved ? "approved" : "not approved"}`,
            volunteerAccessEmail(
              { active, applicationApproved, patrolApproved },
              false,
            ),
          ),
        ),
      ),
    ),
  },
  {
    id: "account-role",
    name: "Account role changed",
    group: "Applications and access",
    trigger: "An organizer promotes or demotes an account.",
    delivery: `${optionalDelivery} The role change also revokes existing sessions.`,
    source: source.volunteers,
    examples: (["organizer", "volunteer"] as const).map((role) =>
      notification(`Role changed to ${role}`, roleChangedEmail(role)),
    ),
  },
  {
    id: "access-registration-cancelled",
    name: "Registration cancelled by access change",
    group: "Applications and access",
    trigger:
      "A volunteer access change also cancels a future registration they are no longer eligible for.",
    delivery: `${optionalDelivery} This is a separate message from the access or approval notification.`,
    source: source.volunteers,
    examples: events.map(({ name, event }) =>
      notification(
        name,
        accessRegistrationCancelledEmail(
          event.meetingPoint,
          Boolean(event.includesOrientation),
        ),
      ),
    ),
  },
  {
    id: "event-changed",
    name: "Event changed",
    group: "Events and patrols",
    trigger:
      "An organizer edits an upcoming event that has confirmed registrations.",
    delivery: optionalDelivery,
    source: source.events,
    examples: events.flatMap(({ name, event }) =>
      [true, false].map((open) =>
        notification(
          `${name}, registration ${open ? "open" : "closed"}`,
          eventChangedEmail(event, open),
        ),
      ),
    ),
  },
  {
    id: "event-cancelled",
    name: "Event cancelled",
    group: "Events and patrols",
    trigger:
      "An organizer cancels an upcoming event and its confirmed registrations.",
    delivery: optionalDelivery,
    source: source.events,
    examples: events.flatMap(({ name, event }) =>
      reasons.map((reason) =>
        notification(
          `${name}, ${reason.name}`,
          eventCancelledEmail(event, reason.value),
        ),
      ),
    ),
  },
  {
    id: "registration-moved",
    name: "Registration moved",
    group: "Events and patrols",
    trigger: "An organizer moves a confirmed registration to another event.",
    delivery: optionalDelivery,
    source: source.events,
    examples: events.flatMap((previous) =>
      events.flatMap((next) =>
        reasons.map((reason) =>
          notification(
            `${previous.name} to ${next.name.toLowerCase()}, ${reason.name}`,
            registrationChangedEmail(
              previous.event,
              {
                ...next.event,
                startsAt: next.event.startsAt + 7 * 86_400_000,
                meetingPoint: "Sample library plaza, south entrance",
              },
              reason.value,
            ),
          ),
        ),
      ),
    ),
  },
  {
    id: "registration-removed",
    name: "Registration removed",
    group: "Events and patrols",
    trigger: "An organizer removes a volunteer's upcoming registration.",
    delivery: optionalDelivery,
    source: source.events,
    examples: events.flatMap(({ name, event }) =>
      reasons.map((reason) =>
        notification(
          `${name}, ${reason.name}`,
          registrationChangedEmail(event, null, reason.value),
        ),
      ),
    ),
  },
  {
    id: "patrol-series-shortened",
    name: "Patrol series ends earlier",
    group: "Events and patrols",
    trigger:
      "An organizer changes a patrol series end date, cancelling booked occurrences beyond that date.",
    delivery: optionalDelivery,
    source: source.patrols,
    examples: [
      notification(
        "Registration beyond the new end date",
        patrolSeriesShortenedEmail(),
      ),
    ],
  },
  {
    id: "patrol-series-changed",
    name: "This and future patrols changed",
    group: "Events and patrols",
    trigger:
      "An organizer updates this and future occurrences of a patrol series.",
    delivery: optionalDelivery,
    source: source.patrols,
    examples: [
      notification(
        "Existing registration preserved",
        patrolSeriesChangedEmail(),
      ),
    ],
  },
  {
    id: "patrol-series-stopped",
    name: "Patrol series stopped",
    group: "Events and patrols",
    trigger:
      "An organizer permanently stops a patrol series from a chosen occurrence onward.",
    delivery: optionalDelivery,
    source: source.patrols,
    examples: reasons.map((reason) =>
      notification(
        `Series stopped ${reason.name}`,
        patrolSeriesStoppedEmail(reason.value),
      ),
    ),
  },
  {
    id: "medic-expiring",
    name: "Medic certification expiring soon",
    group: "Medic certifications",
    trigger:
      "The scheduled discovery job finds a medic certification expiring within the next 30 days.",
    delivery:
      "Automatic production-only reminder. Scheduled delivery uses the persistent notification ledger to avoid duplicate reminders for the same expiry cycle.",
    source: source.medic,
    examples: [
      example(
        "Within 30 days of expiry",
        medicCertificationEmail("warning", "2026-11-15", origin),
      ),
    ],
  },
  {
    id: "medic-expired",
    name: "Medic certification expired",
    group: "Medic certifications",
    trigger:
      "The scheduled discovery job finds that a medic certification has expired.",
    delivery:
      "Automatic production-only reminder, separate from the expiring-soon warning. Local development and branch previews do not run these sends.",
    source: source.medic,
    examples: [
      example(
        "After the expiry date",
        medicCertificationEmail("expired", "2026-10-20", origin),
      ),
    ],
  },
];
