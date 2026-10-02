interface Result {
  message?: string;
  id?: string;
  next?: string;
  twoFactorRedirect?: boolean;
  totpURI?: string;
  backupCodes?: string[];
  localEmail?: { email: string; code: string; url: string };
}

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

async function post(path: string, body: object): Promise<Result> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const result: Result = await response.json();
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

function finish(result: Result) {
  if (result.twoFactorRedirect) {
    document
      .querySelector<HTMLFormElement>("[data-email-request]")
      ?.setAttribute("hidden", "");
    document
      .querySelector<HTMLFormElement>("[data-email-code]")
      ?.setAttribute("hidden", "");
    const factor = document.querySelector<HTMLFormElement>(
      "[data-second-factor]",
    );
    if (factor) {
      factor.hidden = false;
      factor.querySelector<HTMLInputElement>("input[name=code]")?.focus();
    } else location.assign("/volunteer/sign-in?second-factor=1");
  } else location.assign(result.next || "/volunteer/account");
}

const pendingFactor = new URLSearchParams(location.search).has("second-factor");

if (pendingFactor) {
  document
    .querySelector<HTMLFormElement>("[data-email-request]")
    ?.setAttribute("hidden", "");
  const factor = document.querySelector<HTMLFormElement>(
    "[data-second-factor]",
  );
  if (factor) factor.hidden = false;
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
  const result = await post("/api/auth/email/request", {
    email: String(values.get("email") ?? ""),
    returnTo: element.dataset.returnTo,
  });
  const code = document.querySelector<HTMLFormElement>("[data-email-code]");
  if (code && result.id) {
    code.hidden = false;
    code.querySelector<HTMLInputElement>('input[name="id"]')!.value = result.id;
    code.querySelector<HTMLInputElement>('input[name="code"]')?.focus();
    message(
      element,
      import.meta.env.DEV
        ? "Local sign-in email ready. No email was sent."
        : "Email sent. You can request another after one minute.",
    );
  }
  if (import.meta.env.DEV && result.localEmail && result.id) {
    const { localEmailDialog } = await import("./local-email-dialog");
    const outcome = await localEmailDialog({
      title: "Local sign-in email",
      emails: [
        {
          to: result.localEmail.email,
          subject: "Your local sign-in code",
          body: `Your code is ${result.localEmail.code}. The code and link expire in one hour; using either invalidates both.`,
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
          await post("/api/auth/email/verify", { id: result.id, code: proof }),
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

form("[data-email-code]", async (_element, values) => {
  finish(
    await post("/api/auth/email/verify", {
      id: String(values.get("id")),
      code: String(values.get("code")),
    }),
  );
});

const link = document.querySelector<HTMLElement>("[data-email-link]");
if (link) {
  const values = new URLSearchParams(location.hash.slice(1));
  // Remove secrets from browser history before redeeming the link.
  history.replaceState(null, "", location.pathname);
  const complete = async () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", complete);
    try {
      finish(
        await post("/api/auth/email/verify", {
          id: values.get("id"),
          token: values.get("token"),
        }),
      );
    } catch (error) {
      message(
        link,
        error instanceof Error
          ? error.message
          : "The link could not be verified.",
      );
    }
  };
  if (document.visibilityState === "visible") void complete();
  else document.addEventListener("visibilitychange", complete);
}

form("[data-second-factor]", async (_element, values) => {
  const backup = values.has("backup");
  finish(
    await post(
      `/api/auth/two-factor/verify-${backup ? "backup-code" : "totp"}`,
      { code: String(values.get("code")) },
    ),
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
  if (
    element
      .querySelector("button")
      ?.textContent?.includes("Complete registration")
  )
    location.assign("/volunteer/account");
});

form("[data-sign-out]", async () => {
  await post("/api/auth/sign-out", {});
  location.assign("/volunteer/sign-in");
});

form("[data-end-session]", async (_element, values) => {
  await post("/api/account/session", { id: String(values.get("id")) });
  location.reload();
});

form("[data-enable-factor]", async (element) => {
  const result = await post("/api/auth/two-factor/enable", { method: "totp" });
  if (!result.totpURI || !result.backupCodes)
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
  await post("/api/auth/two-factor/verify-totp", {
    code: String(values.get("code")),
  });
  location.reload();
});

export {};
