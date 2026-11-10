import { contactEmail } from "./site";

// Pure message formatting shared by delivery and the local docs preview. Keep
// provider calls, database access, credentials, and sample data out of this file.
export interface EmailContent {
  subject: string;
  text: string;
  html?: string;
}

export const emailSenders = {
  accounts: "After Hours Outreach <accounts@afterhoursoutreach.ca>",
  notifications: "After Hours Outreach <info@afterhoursoutreach.ca>",
} as const;

export interface SignInEmailInput {
  code: string;
  url: string;
  purpose?: "change-email";
}

const signInExpiry =
  "The link and code expire in 10 minutes and can only be used once.";
const signInSecurity =
  "If you did not request this, you can safely ignore this email.";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphs(text: string) {
  return text
    .split("\n\n")
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;">${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`,
    )
    .join("\n");
}

function emailLayout(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;table-layout:fixed;">
        <tr><td style="padding:28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#202020;overflow-wrap:anywhere;">
          <h1 style="margin:0 0 20px;font-size:22px;line-height:30px;font-weight:600;">${escapeHtml(title)}</h1>
          ${body}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

interface EmailAction {
  label: string;
  textLabel: string;
  url: string;
}

function actionLink({ label, url }: EmailAction) {
  // Auth URLs may carry credentials in the fragment; escape without parsing it.
  return `<p style="margin:24px 0 16px;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background-color:#4169e1;color:#ffffff;font-size:15px;font-weight:bold;line-height:24px;text-decoration:none;">${escapeHtml(label)}</a></p>`;
}

function emailContent(subject: string, text: string, action?: EmailAction) {
  return {
    subject,
    text: `${text}${action ? `\n\n${action.textLabel}: ${action.url}` : ""}`,
    html: emailLayout(
      subject,
      paragraphs(text) + (action ? actionLink(action) : ""),
    ),
  };
}

function verificationCode(code: string) {
  return `<p style="margin:0 0 20px;padding:12px 16px;border:1px solid #e7e7e7;border-radius:6px;background-color:#f7f7f7;font-family:monospace;font-size:24px;line-height:32px;text-align:center;">${escapeHtml(code)}</p>`;
}

export function signInEmailContent(email: SignInEmailInput): EmailContent {
  if (email.purpose === "change-email") {
    const subject = "Confirm your email change";
    const instructions =
      "Enter this code in your account settings to confirm your new email address:";
    const expiry =
      "The code expires in 10 minutes and can only be used once. A new code replaces the previous code. Your email address changes only after confirmation.";
    return {
      subject,
      text: `${instructions} ${email.code}\n\n${expiry}\n\n${signInSecurity}`,
      html: emailLayout(
        subject,
        paragraphs(instructions) +
          verificationCode(email.code) +
          paragraphs(`${expiry}\n\n${signInSecurity}`),
      ),
    };
  }
  return {
    subject: `${email.code} is your sign-in code`,
    text: `Sign in: ${email.url}\n\nOr enter this code on the device that requested it: ${email.code}\n\n${signInExpiry}\n\n${signInSecurity}`,
    html: emailLayout(
      "Sign in to After Hours Outreach",
      paragraphs(
        "Enter this code on the sign-in page, or use the link below.",
      ) +
        verificationCode(email.code) +
        actionLink({ label: "Sign in", textLabel: "Sign in", url: email.url }) +
        paragraphs(`${signInExpiry}\n\n${signInSecurity}`),
    ),
  };
}

// These messages are composed inside atomic SQL writes. Sharing their templates
// keeps previews accurate without moving transactional reads into JS.
export const applicationSubmittedTemplate = emailContent(
  "Volunteer application ready for review",
  "Applicant: {{applicant}}\nSubmitted: {{submittedAt}}\n\nOrganizer sign-in required.",
  {
    label: "Review application",
    textLabel: "Review application",
    url: "{{reviewUrl}}",
  },
);

export const accessRegistrationCancelledTemplate = emailContent(
  "Your event registration was cancelled",
  "Your registration for a patrol{{orientation}} at {{meetingPoint}} was cancelled because your volunteer access changed. Check your account or contact an organizer.",
);

export function renderEmailText(
  template: string,
  values: Record<string, string>,
) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key))
      throw new Error(`Missing email template value: ${key}`);
    return values[key];
  });
}

export function applicationSubmittedEmail(values: {
  applicant: string;
  submittedAt: string;
  reviewUrl: string;
}): EmailContent {
  const normalized = {
    ...values,
    applicant: values.applicant.replaceAll("\r", " ").replaceAll("\n", " "),
  };
  return {
    subject: applicationSubmittedTemplate.subject,
    text: renderEmailText(applicationSubmittedTemplate.text, normalized),
    html: renderEmailText(
      applicationSubmittedTemplate.html,
      Object.fromEntries(
        Object.entries(normalized).map(([key, value]) => [
          key,
          escapeHtml(value),
        ]),
      ),
    ),
  };
}

export function accessRegistrationCancelledEmail(
  meetingPoint: string,
  includesOrientation: boolean,
): EmailContent {
  return emailContent(
    accessRegistrationCancelledTemplate.subject,
    renderEmailText(accessRegistrationCancelledTemplate.text, {
      orientation: includesOrientation ? " (includes orientation)" : "",
      meetingPoint,
    }),
  );
}

interface VolunteerAccess {
  active: boolean;
  applicationApproved: boolean;
  patrolApproved: boolean;
}

export function volunteerAccessEmail(
  { active, applicationApproved, patrolApproved }: VolunteerAccess,
  applicationApprovalChanged: boolean,
  approvingOrganizerName?: string,
  revocationReason?: string,
): EmailContent {
  const reason = revocationReason ? `Reason: ${revocationReason}\n\n` : "";
  const nextStep = !active
    ? `Your volunteer account is currently inactive. Please contact an organizer at ${contactEmail} to restore access.`
    : !applicationApproved
      ? "Sign in to review your application steps on the Volunteer page."
      : patrolApproved
        ? "Sign in to browse upcoming patrols and register for an available spot."
        : 'If needed, complete Naloxone 101, then confirm completion on the Volunteer page. Register for an "Orientation + Patrol" event. Patrols without orientation require separate organizer approval.';
  if (!applicationApprovalChanged)
    return emailContent(
      "Your volunteer access changed",
      `Account: ${active ? "active" : "inactive"}. Application: ${applicationApproved ? "approved" : "awaiting approval"}. Patrol access: ${patrolApproved ? "approved" : "not approved"}.\n\n${reason}${nextStep}`,
    );
  if (!applicationApproved)
    return emailContent(
      "Your volunteer application approval was revoked",
      `Your application is awaiting organizer approval again.\n\n${reason}${nextStep}\n\nCheck your account for registration changes.`,
    );
  return emailContent(
    "Your volunteer application is approved",
    `Your volunteer application is approved${approvingOrganizerName ? ` by ${approvingOrganizerName}` : ""}! Thank you for volunteering.\n\n${nextStep}`,
  );
}

export function roleChangedEmail(
  role: "volunteer" | "organizer",
): EmailContent {
  return emailContent(
    "Your account role changed",
    `Your role is now ${role}. Sign in again to continue.`,
  );
}

export function applicationRejectedEmail(reason: string): EmailContent {
  return emailContent(
    "Your volunteer application was not approved",
    `Your volunteer application was not approved.\n\nReason: ${reason}\n\nView the decision on the Volunteer page. Contact ${contactEmail} if you have questions.`,
  );
}

export interface EmailEvent {
  type: "patrol" | "orientation";
  includesOrientation?: number;
  startsAt: number;
  meetingPoint: string;
}

export function eventDescription(event: EmailEvent) {
  return `Patrol${(event.includesOrientation ?? event.type === "orientation") ? " (includes orientation)" : ""}: ${new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "America/Vancouver",
      dateStyle: "full",
      timeStyle: "short",
    },
  ).format(new Date(event.startsAt))}\nMeeting point: ${event.meetingPoint}`;
}

export function eventChangedEmail(
  event: EmailEvent,
  open: boolean,
): EmailContent {
  return emailContent(
    "Your event changed",
    `${eventDescription(event)}\n\n${open ? "Registration is open." : "Registration is closed. Your existing spot is still reserved."}`,
  );
}

export function eventCancelledEmail(
  event: EmailEvent,
  reason: string,
): EmailContent {
  return emailContent(
    "Your event was cancelled",
    `${eventDescription(event)}\n\nThis event was cancelled.${reason ? `\nReason: ${reason}` : ""}`,
  );
}

export function registrationChangedEmail(
  previous: EmailEvent,
  next: EmailEvent | null,
  reason: string,
): EmailContent {
  return emailContent(
    next
      ? "Your event registration was moved"
      : "Your event registration was removed",
    `${eventDescription(previous)}\n\n${next ? `An organizer moved your registration to:\n${eventDescription(next)}` : "An organizer removed your registration."}${reason ? `\nReason: ${reason}` : ""}`,
  );
}

export function patrolSeriesShortenedEmail(): EmailContent {
  return emailContent(
    "Your event was cancelled",
    "This patrol series ended before your scheduled event. Your registration was cancelled.",
  );
}

export function patrolSeriesChangedEmail(): EmailContent {
  return emailContent(
    "Your patrol changed",
    "This patrol series changed. Your existing spot is still reserved. Check the Volunteer page for the updated date, time and meeting point.",
  );
}

export function patrolSeriesStoppedEmail(reason: string): EmailContent {
  return emailContent(
    "Your patrol was cancelled",
    `This patrol series was stopped. Your registration was cancelled.${reason ? `\nReason: ${reason}` : ""}`,
  );
}

/** Event, access, approval and role messages all use this delivery footer.
 * Render from the saved text before the provider payload is frozen for retries.
 */
export function eventNotificationEmail(
  content: EmailContent,
  origin: string,
): EmailContent {
  return emailContent(content.subject, content.text, {
    label: "View events",
    textLabel: "Events",
    url: `${origin}/events`,
  });
}

export function medicCertificationEmail(
  kind: "warning" | "expired",
  expiry: string,
  origin: string,
): EmailContent {
  const warning = kind === "warning";
  return emailContent(
    warning
      ? "Your medic certification is expiring soon"
      : "Your medic certification has expired",
    `${
      warning
        ? `Your medic certification expires on ${expiry}, within the next 30 days. It remains valid through that date. Please arrange renewal.`
        : `Your medic certification expired on ${expiry}. Please renew before volunteering as a medic.`
    }\n\nIf you have renewed or the date is incorrect, update it in your account.`,
    {
      label: "Update certification",
      textLabel: "Your account",
      url: `${origin}/volunteer/account`,
    },
  );
}
