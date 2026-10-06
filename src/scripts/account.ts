import { authClient, showSecondFactor } from "./auth-client";
import type { SignInEmail } from "../server/auth/services";

if (import.meta.env.DEV) {
  void import("./account-switcher").then(({ initAccountSwitcher }) =>
    initAccountSwitcher(),
  );
}

const accountMenu = document.querySelector<HTMLDetailsElement>(
  "[data-account-menu]",
);
if (accountMenu) {
  document.addEventListener("click", (event) => {
    if (
      accountMenu.open &&
      event.target instanceof Node &&
      !accountMenu.contains(event.target)
    )
      accountMenu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !accountMenu.open) return;
    accountMenu.open = false;
    accountMenu.querySelector<HTMLElement>("summary")?.focus();
  });
}

// Volunteer profile and session-ID endpoints are application APIs, not auth routes.
async function post(path: string, body: object) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const result: { message?: string; next?: string } = await response.json();
  if (!response.ok)
    throw new Error(result.message || "The request failed. Please try again.");
  return result;
}

function message(element: Element, text: string) {
  const target = element.querySelector<HTMLElement>("[data-form-message]");
  if (target) {
    target.textContent = text;
    target.hidden = false;
  }
}

function form(
  selector: string,
  submit: (element: HTMLFormElement, values: FormData) => Promise<void>,
) {
  document.querySelectorAll<HTMLFormElement>(selector).forEach((element) => {
    element.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = element.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      );
      if (button?.disabled) return;
      const values = new FormData(element);
      if (button) button.disabled = true;
      try {
        await submit(element, values);
      } catch (error) {
        message(
          element,
          error instanceof Error
            ? error.message
            : "The request failed. Please try again.",
        );
      } finally {
        if (button) button.disabled = false;
      }
    });
  });
}

function finish(result: object) {
  // The client plugin has already displayed the challenge. Do not navigate away.
  if ("twoFactorRedirect" in result && result.twoFactorRedirect === true)
    return;
  // `next` is added by our registration/return-to hooks, not a built-in field.
  location.assign(
    "next" in result && typeof result.next === "string"
      ? result.next
      : "/volunteer/account",
  );
}

const pendingFactor = new URLSearchParams(location.search).has("second-factor");

if (pendingFactor) showSecondFactor();

function emailOptions(returnTo?: string) {
  return { query: { returnTo: returnTo ?? "/volunteer/account" } };
}

form("[data-email-request]", async (element, values) => {
  if (import.meta.env.DEV) {
    const { chooseEmailOutcome } = await import("./local-email-dialog");
    const outcome = await chooseEmailOutcome();
    if (!outcome) return;
    if (outcome !== "success") {
      message(
        element,
        outcome === "failure"
          ? "We could not send the email. Try again later. (Simulated locally.)"
          : "Too many email requests. Try again after one minute. (Simulated locally.)",
      );
      return;
    }
  }
  const email = String(values.get("email") ?? "")
    .trim()
    .toLowerCase();
  const result: { success: boolean; localEmail?: SignInEmail } =
    await authClient.emailOtp.sendVerificationOtp(
      { email, type: "sign-in" },
      emailOptions(element.dataset.returnTo),
    );
  const code = document.querySelector<HTMLFormElement>("[data-email-code]");
  if (code && result.success) {
    code.hidden = false;
    code.dataset.returnTo = element.dataset.returnTo;
    code.querySelector<HTMLInputElement>('input[name="email"]')!.value = email;
    code.querySelector<HTMLInputElement>('input[name="code"]')?.focus();
    message(
      element,
      import.meta.env.DEV
        ? "Local sign-in email ready. No email was sent."
        : "Email sent. You can request another after one minute.",
    );
  }
  if (import.meta.env.DEV && result.localEmail) {
    const { localEmailDialog } = await import("./local-email-dialog");
    const outcome = await localEmailDialog({
      title: "Local sign-in email",
      emails: [
        {
          to: result.localEmail.email,
          subject: "Your local sign-in code",
          body: `Your code is ${result.localEmail.code}. The code and link expire in ten minutes; using either invalidates both. A new email replaces the previous code.`,
          href: result.localEmail.url,
        },
      ],
      actions: [
        { value: "valid", label: "Use valid code" },
        { value: "wrong", label: "Simulate wrong code" },
      ],
    });
    if (outcome) {
      try {
        const proof =
          outcome === "valid"
            ? result.localEmail.code
            : result.localEmail.code === "000000"
              ? "000001"
              : "000000";
        finish(
          await authClient.signIn.emailOtp(
            { email, otp: proof },
            emailOptions(element.dataset.returnTo),
          ),
        );
      } catch (error) {
        message(
          code ?? element,
          error instanceof Error
            ? error.message
            : "The code could not be verified.",
        );
      }
    }
  }
});

form("[data-email-code]", async (element, values) => {
  finish(
    await authClient.signIn.emailOtp(
      {
        email: String(values.get("email")),
        otp: String(values.get("code")),
      },
      emailOptions(element.dataset.returnTo),
    ),
  );
});

const link = document.querySelector<HTMLFormElement>("[data-email-link]");
if (link) {
  const values = new URLSearchParams(location.hash.slice(1));
  // Remove secrets from browser history immediately; keep them only in memory.
  history.replaceState(null, "", location.pathname);
  const email = values.get("email");
  const otp = values.get("otp");
  const button = link.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (email && otp && /^\d{6}$/.test(otp)) {
    const address = link.querySelector<HTMLElement>("[data-sign-in-email]");
    if (address) address.textContent = email;
    if (button) button.disabled = false;
    // An explicit confirmation avoids consuming codes during mail-scanner visits.
    form("[data-email-link]", async () => {
      finish(
        await authClient.signIn.emailOtp(
          { email, otp },
          emailOptions(values.get("returnTo") ?? undefined),
        ),
      );
    });
  } else message(link, "That sign-in link is incomplete. Request a new email.");
}

form("[data-second-factor]", async (_element, values) => {
  const backup = values.has("backup");
  const body = { code: String(values.get("code")) };
  finish(
    backup
      ? await authClient.twoFactor.verifyBackupCode(body)
      : await authClient.twoFactor.verifyTotp(body),
  );
});

form("[data-account-profile]", async (element, values) => {
  const body = Object.fromEntries(
    [...values].filter(([key]) => key !== "teams"),
  );
  const result = await post("/api/account/profile", {
    ...body,
    teams: values.getAll("teams"),
  });
  const menuName = document.querySelector<HTMLElement>(
    "[data-account-menu-name]",
  );
  if (menuName)
    menuName.textContent =
      String(values.get("name") ?? "").trim() || "Your account";
  message(element, result.message || "Profile saved.");
  if (element.hasAttribute("data-registration"))
    location.assign(result.next ?? "/volunteer/account");
});

form("[data-sign-out]", async () => {
  await authClient.signOut();
  location.assign("/volunteer/sign-in");
});

form("[data-end-session]", async (_element, values) => {
  await post("/api/account/session", { id: String(values.get("id")) });
  location.reload();
});

form("[data-enable-factor]", async (element) => {
  const result = await authClient.twoFactor.enable({ method: "totp" });
  if (result.method !== "totp" || !result.totpURI || !result.backupCodes)
    throw new Error("Could not start authenticator setup.");
  const setup = document.querySelector<HTMLElement>("[data-factor-setup]")!;
  setup.querySelector<HTMLElement>("[data-factor-key]")!.textContent = new URL(
    result.totpURI,
  ).searchParams.get("secret");
  setup.querySelector<HTMLElement>("[data-backup-codes]")!.textContent =
    result.backupCodes.join("\n");
  setup.hidden = false;
  element.hidden = true;
});

form("[data-confirm-factor]", async (_element, values) => {
  await authClient.twoFactor.verifyTotp({
    code: String(values.get("code")),
  });
  location.reload();
});

export {};
