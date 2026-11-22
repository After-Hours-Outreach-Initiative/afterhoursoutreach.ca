import { RequestError } from "../http";
import { emailSenders, signInEmailContent } from "../../data/email-templates";
import { sendEmail, type EmailSender } from "../email";
import { buildMode, developmentBuild } from "../build-env";

export interface SignInEmail {
  email: string;
  code: string;
  url: string;
  id: string;
  purpose?: "change-email";
}

/** Hosted previews show sign-in emails instead of sending them. Both the build
 * and the runtime must agree, so a production Worker can never return a code. */
export function showsSignInEmail(environment: string) {
  return (
    developmentBuild() ||
    environment === "local" ||
    (buildMode() === "preview" && environment === "preview")
  );
}

export async function sendSignInEmail(
  sender: EmailSender | undefined,
  email: SignInEmail,
  environment: string,
) {
  // A dev server or preview must never contact the email provider. No shared outbox.
  if (showsSignInEmail(environment)) return email;
  if (!sender)
    throw new RequestError(503, "Sign-in email is not configured yet.");
  const outcome = await sendEmail(sender, {
    from: emailSenders.accounts,
    to: [email.email],
    ...signInEmailContent(email),
  });
  if (outcome === "limited")
    throw new RequestError(429, "Too many requests. Try again later.");
  if (outcome !== "sent")
    throw new RequestError(
      503,
      "We could not send the email. Try again later.",
    );
}
