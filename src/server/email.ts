import { emailPolicy } from "./db/policy";

/** Frozen outbox request. `from` is "Name <address>", as in emailSenders. */
export interface EmailPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

export type EmailSender = Pick<SendEmail, "send">;

/**
 * - sent: Cloudflare accepted the message (not confirmed inbox delivery).
 * - failed: rejected before sending; safe to retry later.
 * - limited: Cloudflare's rate or daily limit; nothing was sent.
 * - unconfirmed: it may have been sent. There are no idempotency keys, so
 *   callers must never retry it automatically.
 */
export type EmailOutcome = "sent" | "failed" | "limited" | "unconfirmed";

const limitedCodes = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
]);
const rejectedCodes = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_SENDER_DOMAIN_NOT_CONFIGURED",
  "E_EMAIL_SENDING_NOT_READY",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_PLAN_RESTRICTED",
  "E_RECIPIENT_SUPPRESSED",
  "E_ACCOUNT_SUSPENDED",
  "E_CONTENT_TOO_LARGE",
]);

function address(value: string): string | EmailAddress {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(value);
  return match?.[1]
    ? { name: match[1], email: match[2] }
    : (match?.[2] ?? value);
}

export function emailOutcome(error: unknown): EmailOutcome {
  // A malformed argument is rejected by the runtime before any request.
  if (error instanceof TypeError) return "failed";
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (limitedCodes.has(code)) return "limited";
  if (rejectedCodes.has(code) || code.startsWith("E_HEADER_")) return "failed";
  return "unconfirmed";
}

/** Never throws, and never logs the message or the error: both can contain recipients. */
export async function sendEmail(
  sender: EmailSender,
  payload: EmailPayload,
  timeoutMs = emailPolicy.timeoutMs,
): Promise<EmailOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sender.send({
        from: address(payload.from),
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        ...(payload.html !== undefined && { html: payload.html }),
        ...(payload.headers && { headers: payload.headers }),
      }),
      // The binding cannot be cancelled, so a slow send stays unconfirmed.
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return "sent";
  } catch (error) {
    return emailOutcome(error);
  } finally {
    clearTimeout(timer);
  }
}
