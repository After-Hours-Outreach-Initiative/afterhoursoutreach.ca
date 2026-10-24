import { RequestError } from "../http";
import { emailPolicy } from "../db/policy";
import { emailSenders, signInEmailContent } from "../../data/email-templates";

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
      from: emailSenders.accounts,
      to: [email.email],
      ...signInEmailContent(email),
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
