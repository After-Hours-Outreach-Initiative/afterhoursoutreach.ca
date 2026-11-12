import { formatEventDate, formatEventDay } from "./event-time";
import { contactEmail } from "./site";

// Pure message formatting shared by delivery and the local docs preview. Keep
// provider calls, database access, credentials, and sample data out of this file.
export interface EmailContent {
  subject: string;
  text: string;
  html?: string;
  /** Notification button; omitted means "View events". Paths are site-relative. */
  action?: EmailButton;
}

export type EmailButton = "none" | { label: string; path: string };

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
  "The code and link expire in 10 minutes and can only be used once.";
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

function emailContent(
  subject: string,
  text: string,
  action?: EmailAction,
  heading = subject,
) {
  return {
    subject,
    text: `${text}${action ? `\n\n${action.textLabel}: ${action.url}` : ""}`,
    html: emailLayout(
      heading,
      paragraphs(text) + (action ? actionLink(action) : ""),
    ),
  };
}

function verificationCode(code: string) {
  return `<p style="margin:0 0 20px;padding:12px 16px;border:1px solid #e7e7e7;border-radius:6px;background-color:#f7f7f7;font-family:monospace;font-size:24px;line-height:32px;text-align:center;">${escapeHtml(code)}</p>`;
}

export function signInEmailContent(email: SignInEmailInput): EmailContent {
  if (email.purpose === "change-email") {
    const subject = `${email.code} is your email change code`;
    const instructions =
      "Enter this code in your account settings to confirm your new email address.";
    const expiry =
      "The code expires in 10 minutes and can only be used once. Requesting a new code replaces this one.";
    return {
      subject,
      text: `${instructions}\n\n${email.code}\n\n${expiry}\n\n${signInSecurity}`,
      html: emailLayout(
        "Confirm your email change",
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
      "Sign in to afterhoursoutreach.ca",
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
  "New volunteer application from {{applicant}}",
  "Applicant: {{applicant}}",
  {
    label: "Review application",
    textLabel: "Review application",
    url: "{{reviewUrl}}",
  },
  "Volunteer application ready for review",
);

const accessCancellationHeading = "Your event registration was cancelled";
const accessCancellationReason =
  "Your registration was cancelled because your volunteer access changed. You'll get a separate email explaining the change.";

/** SQL fallback for a registration created after the dates were formatted. */
export const accessRegistrationCancelledTemplate = emailContent(
  accessCancellationHeading,
  `Event type: {{eventType}}\n\n${accessCancellationReason}`,
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
  reviewUrl: string;
}): EmailContent {
  const normalized = {
    ...values,
    applicant: values.applicant.replaceAll("\r", " ").replaceAll("\n", " "),
  };
  return {
    subject: renderEmailText(applicationSubmittedTemplate.subject, normalized),
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
  startsAt: number,
  includesOrientation: boolean,
): EmailContent {
  return emailContent(
    `Your registration for ${formatEventDay(startsAt)} was cancelled`,
    `${eventDetails(startsAt, includesOrientation)}\n\n${accessCancellationReason}`,
    undefined,
    accessCancellationHeading,
  );
}

interface VolunteerAccess {
  active: boolean;
  applicationApproved: boolean;
  patrolApproved: boolean;
}

export type VolunteerAccessField =
  "active" | "applicationApproved" | "patrolApproved";

export function volunteerAccessEmail(
  { active, applicationApproved, patrolApproved }: VolunteerAccess,
  changed: readonly VolunteerAccessField[],
  approvingOrganizerName?: string,
  revocationReason?: string,
): EmailContent {
  const reason = revocationReason ? `Reason: ${revocationReason}\n\n` : "";
  const inactive = `Contact an organizer at ${contactEmail} to restore access.`;
  const cancelled =
    "Any upcoming registrations were cancelled, and you'll get a separate email for each.";
  const register = patrolApproved
    ? "You can register for any upcoming patrol with open spots."
    : "You can register for any upcoming orientation patrol with open spots.";
  const applicationButton = {
    label: "View application",
    path: "/volunteer",
  } as const;
  const approvedNextStep = !active
    ? `Your volunteer account is inactive, so you can't register for events yet. ${inactive}`
    : register;
  if (!changed.includes("applicationApproved")) {
    if (changed.includes("active") && !active)
      return {
        ...emailContent(
          "Your volunteer account is inactive",
          `You can't register for events while your account is inactive. ${inactive}\n\n${cancelled}`,
        ),
        action: "none",
      };
    if (changed.includes("active"))
      return applicationApproved
        ? emailContent(
            "Your volunteer account is active again",
            `${reason}${register}`,
          )
        : {
            ...emailContent(
              "Your volunteer account is active again",
              "Your application is awaiting organizer approval.",
            ),
            action: applicationButton,
          };
    const subject = patrolApproved
      ? "You're approved for patrols"
      : "Your patrol approval was revoked";
    if (!active)
      return {
        ...emailContent(
          subject,
          `${reason}Your volunteer account is inactive, so you can't register for events yet. ${inactive}`,
        ),
        action: "none",
      };
    return emailContent(
      subject,
      patrolApproved
        ? "You can now register for any upcoming patrol with open spots, not just orientation patrols."
        : `${reason}You can still register for any upcoming orientation patrol with open spots. Any other upcoming registrations were cancelled, and you'll get a separate email for each.`,
    );
  }
  if (!applicationApproved)
    return {
      ...emailContent(
        "Your volunteer application approval was revoked",
        `Your application is awaiting organizer approval again, so you can't register for events until it's approved.\n\n${reason}${active ? "" : `Your volunteer account is also inactive. ${inactive}\n\n`}${cancelled}`,
      ),
      action: applicationButton,
    };
  return {
    ...emailContent(
      "Your volunteer application is approved",
      `${approvingOrganizerName ?? "An organizer"} approved your volunteer application. Thank you for volunteering!\n\n${approvedNextStep}`,
    ),
    ...(active ? {} : { action: "none" as const }),
  };
}

/** Tells the organization inbox that an organizer approved an application. */
export function applicationApprovedNoticeEmail(values: {
  applicant: string;
  approvedBy: string;
  profilePath: string;
}): EmailContent {
  const line = (value: string) =>
    value.replaceAll("\r", " ").replaceAll("\n", " ");
  return {
    ...emailContent(
      `Volunteer application from ${line(values.applicant)} approved`,
      `Applicant: ${line(values.applicant)}\nApproved by: ${line(values.approvedBy)}`,
      undefined,
      "Volunteer application approved",
    ),
    action: { label: "View profile", path: values.profilePath },
  };
}

export function roleChangedEmail(
  role: "volunteer" | "organizer",
): EmailContent {
  return {
    ...(role === "organizer"
      ? emailContent(
          "You're now an organizer",
          "You can now review applications, manage volunteers and run events. You were signed out, so sign in again to use your new access.",
        )
      : emailContent(
          "You're no longer an organizer",
          "Your account is now a volunteer account. You were signed out, so sign in again to continue.",
        )),
    action: { label: "Sign in", path: "/volunteer/sign-in" },
  };
}

export function applicationRejectedEmail(reason: string): EmailContent {
  return {
    ...emailContent(
      "Your volunteer application was not approved",
      `Reason: ${reason}\n\nIf you have questions, contact ${contactEmail}.`,
    ),
    action: { label: "View application", path: "/volunteer" },
  };
}

export interface EmailEvent {
  type: "patrol" | "orientation";
  includesOrientation?: number;
  startsAt: number;
  meetingPoint: string;
}

/** Event lines matching the event cards; the meeting point only where it is still useful. */
export function eventDetails(
  startsAt: number,
  includesOrientation: boolean,
  meetingPoint?: string,
) {
  return [
    `Date: ${formatEventDate(startsAt)}`,
    `Event type: ${includesOrientation ? "Orientation + Patrol" : "Patrol"}`,
    ...(meetingPoint ? [`Meeting point: ${meetingPoint}`] : []),
  ].join("\n");
}

function withOrientation(event: EmailEvent) {
  return Boolean(event.includesOrientation ?? event.type === "orientation");
}

const reasonLine = (reason: string) => (reason ? `\nReason: ${reason}` : "");

export function eventChangedEmail(event: EmailEvent): EmailContent {
  return emailContent(
    `Your event on ${formatEventDay(event.startsAt)} changed`,
    `${eventDetails(event.startsAt, withOrientation(event), event.meetingPoint)}\n\nYour spot is still reserved.`,
    undefined,
    "Your event changed",
  );
}

export function eventCancelledEmail(
  event: EmailEvent,
  reason: string,
): EmailContent {
  return emailContent(
    `Your event on ${formatEventDay(event.startsAt)} was cancelled`,
    `${eventDetails(event.startsAt, withOrientation(event))}${reasonLine(reason)}\n\nAn organizer cancelled this event.`,
    undefined,
    "Your event was cancelled",
  );
}

export function registrationChangedEmail(
  previous: EmailEvent,
  next: EmailEvent | null,
  reason: string,
): EmailContent {
  if (!next)
    return emailContent(
      `Your registration for ${formatEventDay(previous.startsAt)} was removed`,
      `${eventDetails(previous.startsAt, withOrientation(previous))}${reasonLine(reason)}\n\nAn organizer removed your registration.`,
      undefined,
      "Your event registration was removed",
    );
  return emailContent(
    `Your registration moved to ${formatEventDay(next.startsAt)}`,
    `New event\n${eventDetails(next.startsAt, withOrientation(next), next.meetingPoint)}\n\nPrevious event\n${eventDetails(previous.startsAt, withOrientation(previous))}${reason ? `\n\nReason: ${reason}` : ""}\n\nAn organizer moved your registration.`,
    undefined,
    "Your event registration was moved",
  );
}

export interface SeriesEmailEvent {
  startsAt: number;
  includesOrientation: boolean;
}

/** Without an event, the undated fallback for registrations made after the date read. */
export function patrolSeriesShortenedEmail(
  event?: SeriesEmailEvent,
): EmailContent {
  const note =
    "This recurring patrol now ends earlier, so this event and your registration were cancelled.";
  return emailContent(
    event
      ? `Your event on ${formatEventDay(event.startsAt)} was cancelled`
      : "Your event was cancelled",
    event
      ? `${eventDetails(event.startsAt, event.includesOrientation)}\n\n${note}`
      : note,
    undefined,
    "Your event was cancelled",
  );
}

export function patrolSeriesRescheduledEmail(
  event?: SeriesEmailEvent,
): EmailContent {
  const note =
    "This recurring patrol now repeats on a different schedule, so this event and your registration were cancelled.";
  return emailContent(
    event
      ? `Your event on ${formatEventDay(event.startsAt)} was cancelled`
      : "Your event was cancelled",
    event
      ? `${eventDetails(event.startsAt, event.includesOrientation)}\n\n${note}`
      : note,
    undefined,
    "Your event was cancelled",
  );
}

export function patrolSeriesChangedEmail(
  event?: SeriesEmailEvent & { meetingPoint: string },
): EmailContent {
  if (event)
    return eventChangedEmail({
      type: "patrol",
      includesOrientation: Number(event.includesOrientation),
      startsAt: event.startsAt,
      meetingPoint: event.meetingPoint,
    });
  return emailContent(
    "Your event changed",
    "This recurring patrol changed. Your spot is still reserved.",
  );
}

export function patrolSeriesStoppedEmail(
  reason: string,
  event?: SeriesEmailEvent,
): EmailContent {
  const note =
    "This recurring patrol was stopped, so this event and your registration were cancelled.";
  return emailContent(
    event
      ? `Your event on ${formatEventDay(event.startsAt)} was cancelled`
      : "Your event was cancelled",
    event
      ? `${eventDetails(event.startsAt, event.includesOrientation)}${reasonLine(reason)}\n\n${note}`
      : `${reason ? `Reason: ${reason}\n\n` : ""}${note}`,
    undefined,
    "Your event was cancelled",
  );
}

/** Event, access, approval and role messages all use this delivery footer.
 * Render from the saved text before the provider payload is frozen for retries.
 */
export function eventNotificationEmail(
  content: EmailContent,
  origin: string,
): EmailContent {
  return emailContent(
    content.subject,
    content.text,
    content.action === "none"
      ? undefined
      : content.action
        ? {
            label: content.action.label,
            textLabel: content.action.label,
            url: `${origin}${content.action.path}`,
          }
        : {
            label: "View events",
            textLabel: "Events",
            url: `${origin}/events`,
          },
  );
}

export function medicCertificationEmail(
  kind: "warning" | "expired",
  expiry: string,
  origin: string,
): EmailContent {
  const warning = kind === "warning";
  const subject = warning
    ? `Your medic certification expires on ${expiry}`
    : `Your medic certification expired on ${expiry}`;
  const [before, after] = warning
    ? [
        "Your medic certification expires on ",
        ". It stays valid through that date.",
      ]
    : [
        "Your medic certification expired on ",
        ". Renew it before volunteering as a medic.",
      ];
  const update =
    "If you've already renewed it or the date is wrong, update it in your account.";
  const action = {
    label: "Update certification",
    textLabel: "Your account",
    url: `${origin}/volunteer/account`,
  };
  return {
    subject,
    text: `${before}${expiry}${after}\n\n${update}\n\n${action.textLabel}: ${action.url}`,
    html: emailLayout(
      warning
        ? "Your medic certification is expiring soon"
        : "Your medic certification has expired",
      `<p style="margin:0 0 16px;">${escapeHtml(before)}<strong>${escapeHtml(expiry)}</strong>${escapeHtml(after)}</p>\n` +
        paragraphs(update) +
        actionLink(action),
    ),
  };
}
