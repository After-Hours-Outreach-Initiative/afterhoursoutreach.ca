import { RequestError } from "../http";
import { emailPolicy } from "../db/policy";

export interface SignInEmail {
  email: string;
  code: string;
  url: string;
  id: string;
  purpose?: "change-email";
}

export async function sendSignInEmail(
  key: string | undefined,
  email: SignInEmail,
  environment: string,
  fetcher: typeof fetch = fetch,
) {
  // A dev server must never contact the email provider, even with a real key
  // or an accidentally selected remote environment. No shared local outbox.
  if (import.meta.env?.DEV || environment === "local") return email;
  if (!key) throw new RequestError(503, "Sign-in email is not configured yet.");
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `sign-in/${email.id}`,
    },
    signal: AbortSignal.timeout(emailPolicy.timeoutMs),
    body: JSON.stringify({
      from: "After Hours Outreach <noreply@afterhoursoutreach.ca>",
      to: [email.email],
      subject:
        email.purpose === "change-email"
          ? "Confirm your After Hours Outreach email change"
          : "Your After Hours Outreach sign-in",
      text:
        email.purpose === "change-email"
          ? `Enter this code in your account settings to confirm your new email address: ${email.code}\n\nThe code expires in ten minutes and can only be used once. Requesting a new code for this address replaces the previous code. Your email address will not change until you confirm it.\n\nIf you did not request this, ignore this email.`
          : `Sign in: ${email.url}\n\nOr enter this code on the device that requested it: ${email.code}\n\nThe link and code expire in ten minutes. Using either one invalidates both. Requesting a new email replaces the previous code.\n\nIf you did not request this, ignore this email.`,
    }),
  });
  // Provider bodies can contain recipient details; never expose or log them.
  if (!response.ok)
    throw new RequestError(
      503,
      "We could not send the email. Try again later.",
    );
  await response.body?.cancel();
}
