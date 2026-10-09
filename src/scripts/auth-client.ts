import { createAuthClient } from "better-auth/client";
import { emailOTPClient, twoFactorClient } from "better-auth/client/plugins";

export function showSecondFactor() {
  for (const selector of [
    "[data-email-request]",
    "[data-email-code]",
    "[data-email-link]",
    "[data-use-different-email]",
  ])
    document.querySelector<HTMLElement>(selector)?.setAttribute("hidden", "");
  const factor = document.querySelector<HTMLFormElement>(
    "[data-second-factor]",
  );
  if (factor) {
    factor.hidden = false;
    factor.querySelector<HTMLInputElement>("input[name=code]")?.focus();
  } else location.assign("/volunteer/sign-in?second-factor=1");
}

export const authClient = createAuthClient({
  basePath: "/api/v1/auth",
  fetchOptions: { credentials: "same-origin", throw: true },
  plugins: [
    emailOTPClient(),
    twoFactorClient({ onTwoFactorRedirect: showSecondFactor }),
  ],
});
