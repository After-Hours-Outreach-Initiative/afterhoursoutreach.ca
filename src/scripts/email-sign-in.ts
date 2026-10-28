import { authClient } from "./auth-client";
import {
  accountErrorMessage,
  clearFormMessage,
  emailCodeErrorMessage,
  showFormMessage as message,
} from "./account-forms";
import { signInDestination } from "../data/account-navigation";
import type { SignInEmail } from "../server/auth/services";

const resendCooldownMs = 30_000;
const initializedPanels = new WeakSet<HTMLElement>();

export function initEmailSignIn(finish: (result: object) => void) {
  for (const panel of document.querySelectorAll<HTMLElement>(
    ".volunteer-signin-panel",
  )) {
    if (initializedPanels.has(panel)) continue;
    initializedPanels.add(panel);
    const request = panel.querySelector<HTMLFormElement>(
      "[data-email-request]",
    );
    const link = panel.querySelector<HTMLFormElement>("[data-email-link]");
    const code = panel.querySelector<HTMLFormElement>("[data-email-code]")!;
    const resend = code.querySelector<HTMLButtonElement>("[data-resend-code]")!;
    const resendHelp = code.querySelector<HTMLElement>("#sign-in-code-help")!;
    const reset = panel.querySelector<HTMLAnchorElement>(
      "[data-use-different-email]",
    )!;
    const requestButton = request?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    const codeButton = code.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    const linkButton = link?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    const emailInput =
      request?.querySelector<HTMLInputElement>('[name="email"]');
    const codeInput = code.querySelector<HTMLInputElement>('[name="code"]')!;
    const ready = requestButton ? !requestButton.disabled : true;
    const requestLabel = requestButton?.textContent ?? "";
    let email = "";
    const returnTo = signInDestination;
    let busy = false;
    let sending = false;
    let resendAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proof: string | null = null;
    let proofRejected = false;

    const options = () => ({ query: { returnTo } });
    const update = () => {
      clearTimeout(timer);
      const remaining = Math.max(0, resendAt - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      resend.disabled = busy || !email || seconds > 0;
      // Reveal after a real cooldown ends, then keep the guidance through resends.
      if (resendAt > 0 && !resend.disabled) {
        resendHelp.hidden = false;
        resend.setAttribute("aria-describedby", resendHelp.id);
      }
      resend.textContent = sending
        ? "Sending email…"
        : seconds > 0
          ? `Resend code (${seconds}s)`
          : "Resend code";
      if (sending) resend.setAttribute("aria-busy", "true");
      else resend.removeAttribute("aria-busy");
      codeButton.disabled = busy;
      if (busy && code.dataset.submitting && !sending)
        codeButton.setAttribute("aria-busy", "true");
      else codeButton.removeAttribute("aria-busy");
      if (linkButton) linkButton.disabled = busy || !proof || proofRejected;
      if (requestButton) {
        requestButton.disabled = busy || !ready;
        requestButton.textContent =
          busy && request?.dataset.submitting
            ? (requestButton.dataset.loadingLabel ?? requestLabel)
            : requestLabel;
        if (busy && request?.dataset.submitting)
          requestButton.setAttribute("aria-busy", "true");
        else requestButton.removeAttribute("aria-busy");
      }
      // Use a deadline, not a decremented counter: background tabs can throttle timers.
      if (remaining > 0) timer = setTimeout(update, remaining % 1000 || 1000);
    };

    const run = async (form: HTMLFormElement, action: () => Promise<void>) => {
      // Sending, activating a link and verifying a code share one in-flight lock.
      if (busy || form.closest("[hidden]")) return;
      busy = true;
      form.dataset.submitting = "true";
      form.setAttribute("aria-busy", "true");
      clearFormMessage(form);
      update();
      try {
        await action();
      } catch (error) {
        message(form, accountErrorMessage(error));
      } finally {
        busy = false;
        sending = false;
        delete form.dataset.submitting;
        form.removeAttribute("aria-busy");
        update();
      }
    };

    const showCode = () => {
      if (request) {
        clearFormMessage(request);
        emailInput!.value = email;
        emailInput!.readOnly = true;
        requestButton!.hidden = true;
      }
      code.hidden = false;
      code.dataset.returnTo = returnTo;
      code.querySelector<HTMLInputElement>('[name="email"]')!.value = email;
      reset.hidden = false;
      reset.href = `/volunteer/sign-in?${new URLSearchParams({ returnTo })}`;
      panel
        .querySelector<HTMLElement>("[data-request-new-email]")
        ?.setAttribute("hidden", "");
      codeInput.focus();
    };

    const verify = async (otp: string) => {
      try {
        finish(await authClient.signIn.emailOtp({ email, otp }, options()));
      } catch (error) {
        message(code, emailCodeErrorMessage(error));
      }
    };

    const send = async (
      owner: HTMLFormElement,
      again: boolean,
      address = email,
    ) => {
      sending = again;
      update();
      if (import.meta.env.DEV) {
        const { chooseEmailOutcome } =
          await import("../dev/scripts/local-email-dialog");
        const outcome = await chooseEmailOutcome();
        if (!outcome) return;
        if (outcome !== "success") {
          message(
            owner,
            outcome === "failure"
              ? "We could not send the email. Try again later. (Simulated locally.)"
              : "Too many email requests. Please wait before trying again. (Simulated locally.)",
          );
          return;
        }
      }
      const result: { success: boolean; localEmail?: SignInEmail } =
        await authClient.emailOtp.sendVerificationOtp(
          { email: address, type: "sign-in" },
          options(),
        );
      if (!result.success)
        throw new Error("We could not send the email. Please try again.");
      email = address;
      // Start only after delivery succeeds, including resends. Failures remain retryable.
      resendAt = Date.now() + resendCooldownMs;
      code.reset();
      clearFormMessage(code);
      showCode();
      if (linkButton) {
        // A new email invalidates the original link as well as its code.
        proof = null;
        proofRejected = true;
        linkButton.hidden = true;
      }
      if (again)
        message(
          code,
          "A new code and link have been sent. Only the latest email will work.",
          "success",
        );
      update();
      if (import.meta.env.DEV && result.localEmail) {
        const { localEmailDialog } =
          await import("../dev/scripts/local-email-dialog");
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
        if (outcome)
          await verify(
            outcome === "valid"
              ? result.localEmail.code
              : result.localEmail.code === "000000"
                ? "000001"
                : "000000",
          );
        else codeInput.focus();
      }
    };

    request?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requestButton?.disabled && !requestButton?.hidden)
        void run(request, () =>
          send(request, false, emailInput!.value.trim().toLowerCase()),
        );
    });
    code.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!codeButton.disabled) void run(code, () => verify(codeInput.value));
    });
    resend.addEventListener("click", () => {
      // Check the deadline as well as disabled state to guard synthetic events.
      if (busy || Date.now() < resendAt || !email) return;
      void run(code, () => send(code, true));
    });
    reset.addEventListener("click", (event) => {
      if (busy) {
        event.preventDefault();
        return;
      }
      if (!request) return; // Link recovery uses the normal sign-in page to reset.
      event.preventDefault();
      email = "";
      resendAt = 0;
      resendHelp.hidden = true;
      resend.removeAttribute("aria-describedby");
      for (const form of [request, code]) {
        form.reset();
        clearFormMessage(form);
      }
      code.querySelector<HTMLInputElement>('[name="email"]')!.value = "";
      delete code.dataset.returnTo;
      code.hidden = true;
      reset.hidden = true;
      request.hidden = false;
      emailInput!.readOnly = false;
      requestButton!.hidden = false;
      update();
      emailInput!.focus();
    });

    if (link) {
      const values = new URLSearchParams(location.hash.slice(1));
      // Remove secrets from browser history immediately; keep them only in memory.
      history.replaceState(null, "", location.pathname);
      email = (values.get("email") ?? "").trim().toLowerCase();
      proof = values.get("otp");
      const activation = values.get("activation");
      const address = link.querySelector<HTMLElement>("[data-sign-in-email]");
      if (address) address.textContent = email;
      const fallback = panel.querySelector<HTMLAnchorElement>(
        "[data-request-new-email]",
      );
      if (fallback)
        fallback.href = `/volunteer/sign-in?${new URLSearchParams({ returnTo })}`;
      if (email && proof && /^\d{6}$/.test(proof)) {
        const activate = () =>
          run(link, async () => {
            message(link, "Signing you in…", "success");
            try {
              // The server requires the signed requesting-browser cookie for
              // automatic activation. Merely fetching this page or its scripts
              // (including a scanner running JS) cannot consume the code.
              finish(
                await authClient.signIn.emailOtp(
                  { email, otp: proof! },
                  {
                    ...options(),
                    headers: { "X-Email-Link-Activation": activation! },
                  },
                ),
              );
            } catch (error) {
              const status = (error as { status?: number })?.status;
              proofRejected = status === 400 || status === 403;
              if (proofRejected) proof = null;
              linkButton!.hidden = proofRejected;
              clearFormMessage(link);
              showCode();
              message(code, emailCodeErrorMessage(error));
            }
          });
        link.addEventListener("submit", (event) => {
          event.preventDefault();
          if (linkButton?.disabled || linkButton?.hidden) return;
          void activate();
        });
        if (activation) void activate();
        else {
          // Older links have no browser binding. Never auto-redeem their code.
          proof = null;
          showCode();
          message(code, "Enter the six-digit code from your email to sign in.");
        }
      } else {
        proof = null;
        message(link, "That sign-in link is incomplete. Request a new email.");
        // Even an incomplete link can recover in place when its email is present.
        if (email) showCode();
      }
    }
    update();
  }
}
