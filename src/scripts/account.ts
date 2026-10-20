import { authClient, showSecondFactor } from "./auth-client";
import { signOut } from "./sign-out";
import { initEmailSignIn } from "./email-sign-in";
import { actionFragment, loadActionPage } from "./action-page";
import {
  applicationDisplayName,
  profileIdentityFields,
  type ApplicationAnswers,
} from "../data/application";
import { accountGreeting } from "../data/account-navigation";
import {
  applicationSubmissionValues,
  initApplicationReview,
} from "./application-review";
import { initApplicationSections } from "./application-sections";
import { initPageContents } from "./page-contents";
import { initPhoneInputs } from "./phone-input";
import { initDateInputs } from "./date-input";
import {
  clearApplicationDraft,
  initApplicationDraft,
} from "./application-draft";
import type { SignInEmail } from "../server/auth/services";
import {
  accountErrorMessage,
  clearFormMessage,
  initAccountFormChanges,
  initMedicCertifications,
  initMotivationWordLimit,
  initReferralSources,
  initRelevantTraining,
  showFormMessage as message,
} from "./account-forms";

if (import.meta.env.DEV) {
  void import("../dev/scripts/account-switcher").then(
    ({ initAccountSwitcher }) => initAccountSwitcher(),
  );
}

const applicationDrafts = new WeakMap<
  HTMLFormElement,
  NonNullable<ReturnType<typeof initApplicationDraft>>
>();

// Volunteer profile and session-ID endpoints are application APIs, not auth routes.
async function post(path: string, body: object) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const result: {
    message?: string;
    next?: string;
    answers?: ApplicationAnswers;
    latest?: ApplicationAnswers;
    draftChanged?: boolean;
    alreadySubmitted?: boolean;
  } = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(result.message || "The request failed. Please try again."),
      result,
    );
  return result;
}

function form(
  selector: string,
  submit: (
    element: HTMLFormElement,
    values: FormData,
  ) => Promise<void | ApplicationAnswers>,
) {
  const initialized = new WeakMap<
    HTMLFormElement,
    ReturnType<typeof initAccountFormChanges> | undefined
  >();
  const initialize = (element: HTMLFormElement) => {
    if (!initialized.has(element)) {
      // Restore before conditional-field initialization can clear hidden answers.
      const draft = initApplicationDraft(element);
      if (draft) applicationDrafts.set(element, draft);
      else if (element.dataset.profileUserId)
        clearApplicationDraft(element.dataset.profileUserId);
      initPhoneInputs(element);
      initDateInputs(element);
      initMedicCertifications(element);
      initRelevantTraining(element);
      initReferralSources(element);
      initMotivationWordLimit(element);
      initApplicationSections(element);
      initApplicationReview(element);
      draft?.start();
      initialized.set(
        element,
        element.hasAttribute("data-save-changes")
          ? initAccountFormChanges(element)
          : undefined,
      );
    }
    return initialized.get(element);
  };
  document.querySelectorAll<HTMLFormElement>(selector).forEach(initialize);
  // Refreshed settings and session rows must keep working without re-running scripts.
  document.addEventListener("submit", async (event) => {
    const element = event.target;
    if (!(element instanceof HTMLFormElement) || !element.matches(selector))
      return;
    event.preventDefault();
    if (element.dataset.submitting) return;
    const changes = initialize(element);
    if (changes && !changes.submitButton()) return;
    const button =
      event.submitter instanceof HTMLButtonElement
        ? event.submitter
        : (changes?.submitButton() ??
          element.querySelector<HTMLButtonElement>('button[type="submit"]'));
    if (
      button?.disabled ||
      button?.closest("[hidden]") ||
      element.closest("[hidden]")
    )
      return;
    clearFormMessage(element);
    element.dataset.submitting = "true";
    changes?.update();
    const emailCancel = element
      .closest("[data-email-settings]")
      ?.querySelector<HTMLButtonElement>("[data-email-cancel]");
    if (emailCancel) emailCancel.disabled = true;
    const values = element.hasAttribute("data-application")
      ? applicationSubmissionValues(element)
      : (changes?.values() ?? new FormData(element));
    const label = button?.textContent;
    element.setAttribute("aria-busy", "true");
    if (button) {
      button.disabled = true;
      if (button.dataset.loadingLabel) {
        button.textContent = button.dataset.loadingLabel;
        button.setAttribute("aria-busy", "true");
      }
    }
    try {
      const answers = await submit(element, values);
      changes?.markSaved(values, answers ?? undefined);
    } catch (error) {
      changes?.conflicted(error);
      message(element, accountErrorMessage(error));
    } finally {
      delete element.dataset.submitting;
      element.removeAttribute("aria-busy");
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (button.dataset.loadingLabel) button.textContent = label ?? "";
      }
      changes?.update();
      if (emailCancel) emailCancel.disabled = false;
    }
  });
}

function finish(result: object) {
  // The client plugin has already displayed the challenge. Do not navigate away.
  if ("twoFactorRedirect" in result && result.twoFactorRedirect === true)
    return;
  // `next` is added by our application/return-to hooks, not a built-in field.
  location.assign(
    "next" in result && typeof result.next === "string"
      ? result.next
      : "/volunteer/account",
  );
}

const pendingFactor = new URLSearchParams(location.search).has("second-factor");

if (pendingFactor) showSecondFactor();

for (const flow of document.querySelectorAll<HTMLElement>(
  "[data-account-contents-flow]",
))
  initPageContents(flow);

initEmailSignIn(finish);
document.addEventListener("account-content-updated", () =>
  initEmailSignIn(finish),
);

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
  const draft = applicationDrafts.get(element);
  let result: Awaited<ReturnType<typeof post>>;
  try {
    const draftState = await draft?.beforeSubmit();
    // Reconciliation may have merged remote answers while awaiting autosave.
    // Never submit the snapshot captured before that wait.
    if (draft) values = applicationSubmissionValues(element);
    const body = Object.fromEntries(
      [...values].filter(
        ([key]) =>
          key !== "teams" &&
          key !== "certifications" &&
          key !== "training" &&
          key !== "heardAboutUsSources" &&
          key !== "codeOfConductAccepted" &&
          (element.hasAttribute("data-application") ||
            !profileIdentityFields.some((field) => field === key)),
      ),
    );
    const payload = {
      ...body,
      teams: values.getAll("teams"),
      certifications: values.getAll("certifications"),
      training: values.getAll("training"),
      applicationUserId: element.dataset.profileUserId,
      intent: draft ? "submit" : "edit",
      ...(draft
        ? { draft: draftState }
        : { baseline: JSON.parse(element.dataset.profileBaseline ?? "null") }),
      ...(element.hasAttribute("data-application") && {
        heardAboutUsSources: values.getAll("heardAboutUsSources"),
        heardAboutUsOther: values
          .getAll("heardAboutUsSources")
          .includes("other")
          ? String(values.get("heardAboutUsOther") ?? "")
          : "",
        codeOfConductAccepted: values.get("codeOfConductAccepted") === "true",
      }),
    };
    // Submitted answers become immutable. Freeze application controls only for
    // the final request so typing cannot be discarded by its success redirect.
    // Profile editors remain editable and rebase newer input on acknowledgement.
    const frozen = draft
      ? [...element.querySelectorAll<HTMLFieldSetElement>("fieldset")].map(
          (field) => ({ field, disabled: field.disabled }),
        )
      : [];
    for (const { field } of frozen) field.disabled = true;
    try {
      result = await post("/api/v1/account/profile", payload);
    } finally {
      if (!draft?.isStopped())
        for (const { field, disabled } of frozen) field.disabled = disabled;
    }
    if (draft && result.alreadySubmitted)
      throw new Error(draft.submissionFound());
    draft?.submitted();
  } catch (error) {
    draft?.resume();
    if ((error as { draftChanged?: boolean })?.draftChanged)
      await draft?.refresh();
    throw error;
  }
  // Saved legal names are display metadata, not editable profile controls.
  const nameAnswers = {
    firstName: String(
      values.get("firstName") ?? element.dataset.profileFirstName ?? "",
    ),
    middleNames: String(
      values.get("middleNames") ?? element.dataset.profileMiddleNames ?? "",
    ),
    lastName: String(
      values.get("lastName") ?? element.dataset.profileLastName ?? "",
    ),
    preferredName:
      result.answers?.preferredName ??
      String(values.get("preferredName") ?? ""),
  };
  for (const menuName of document.querySelectorAll<HTMLElement>(
    "[data-account-menu-name]",
  ))
    menuName.textContent =
      applicationDisplayName(nameAnswers) || "Your account";
  const name = accountGreeting(nameAnswers);
  for (const greeting of document.querySelectorAll<HTMLElement>(
    "[data-account-greeting]",
  )) {
    greeting.textContent = name;
    greeting
      .closest("summary")
      ?.setAttribute(
        "aria-label",
        name === "Account" ? "Account" : `Account for ${name}`,
      );
  }
  if (element.hasAttribute("data-application")) {
    message(element, result.message || "Profile saved.", "success");
    location.assign(result.next ?? "/volunteer/account");
  }
  return result.answers;
});

function closeEmailEditor(settings: HTMLElement) {
  const restoreFocus =
    settings.contains(document.activeElement) ||
    document.activeElement === document.body;
  for (const element of settings.querySelectorAll<HTMLFormElement>(
    "[data-email-change-request], [data-email-change-confirm]",
  )) {
    element.reset();
    clearFormMessage(element);
  }
  const confirm = settings.querySelector<HTMLFormElement>(
    "[data-email-change-confirm]",
  );
  if (confirm) {
    confirm.hidden = true;
    confirm.querySelector<HTMLInputElement>('[name="newEmail"]')!.value = "";
  }
  settings.querySelector<HTMLElement>("[data-email-editor]")!.hidden = true;
  const edit = settings.querySelector<HTMLButtonElement>("[data-email-edit]")!;
  edit.hidden = false;
  edit.setAttribute("aria-expanded", "false");
  if (restoreFocus) edit.focus({ preventScroll: true });
}

for (const settings of document.querySelectorAll<HTMLElement>(
  "[data-email-settings]",
)) {
  const edit = settings.querySelector<HTMLButtonElement>("[data-email-edit]")!;
  edit.disabled = false;
  edit.addEventListener("click", () => {
    clearFormMessage(settings);
    settings.querySelector<HTMLElement>("[data-email-editor]")!.hidden = false;
    edit.hidden = true;
    edit.setAttribute("aria-expanded", "true");
    (
      settings.querySelector<HTMLInputElement>('[name="newEmail"]') ??
      settings.querySelector<HTMLButtonElement>("[data-sign-out] button")
    )?.focus();
  });
  settings
    .querySelector("[data-email-cancel]")!
    .addEventListener("click", () => {
      if (settings.querySelector("[data-submitting]")) return;
      closeEmailEditor(settings);
      clearFormMessage(settings);
    });
}

form("[data-email-change-request]", async (element, values) => {
  const newEmail = String(values.get("newEmail") ?? "")
    .trim()
    .toLowerCase();
  const result: { success: boolean; localEmail?: SignInEmail } =
    await authClient.emailOtp.requestEmailChange({ newEmail });
  if (!result.success) throw new Error("Could not request an email change.");
  const confirm = element
    .closest("[data-email-settings]")!
    .querySelector<HTMLFormElement>("[data-email-change-confirm]")!;
  confirm.reset();
  clearFormMessage(confirm);
  confirm.querySelector<HTMLInputElement>('[name="newEmail"]')!.value =
    newEmail;
  confirm.hidden = false;
  message(
    element,
    `If ${newEmail} is available, a verification code has been sent. Enter it below.`,
    "success",
  );
  const code = confirm.querySelector<HTMLInputElement>('[name="code"]')!;
  code.focus();
  if (import.meta.env.DEV && result.localEmail) {
    const { localEmailDialog } =
      await import("../dev/scripts/local-email-dialog");
    const outcome = await localEmailDialog({
      title: "Local email-change code",
      emails: [
        {
          to: result.localEmail.email,
          subject: "Confirm your email change",
          body: `Your verification code is ${result.localEmail.code}. It expires in ten minutes. Your email address has not changed yet.`,
        },
      ],
      actions: [{ value: "fill", label: "Fill verification code" }],
    });
    if (outcome === "fill") code.value = result.localEmail.code;
    code.focus();
  }
});

form("[data-email-change-confirm]", async (element, values) => {
  const newEmail = String(values.get("newEmail"));
  await authClient.emailOtp.changeEmail({
    newEmail,
    otp: String(values.get("code")),
  });
  for (const address of document.querySelectorAll<HTMLElement>(
    "[data-account-email]",
  ))
    address.textContent = newEmail;
  const settings = element.closest<HTMLElement>("[data-email-settings]")!;
  closeEmailEditor(settings);
  message(
    settings,
    "Email address changed. Use your new address the next time you sign in.",
    "success",
  );
});

form("[data-sign-out]", async () => {
  const application = document.querySelector<HTMLFormElement>(
    "[data-account-profile][data-application]",
  );
  const draft = application ? applicationDrafts.get(application) : undefined;
  if (draft && !(await draft.beforeSignOut())) return;
  try {
    await signOut();
  } catch (error) {
    draft?.resume();
    throw error;
  }
  draft?.signedOut();
  location.assign("/volunteer/sign-in");
});

form("[data-end-session]", async (element, values) => {
  await post("/api/v1/account/session", { id: String(values.get("id")) });
  const row = element.closest<HTMLElement>("[data-session-row]")!;
  const sessions = row.closest<HTMLElement>("[data-account-sessions]")!;
  const restoreFocus =
    element.contains(document.activeElement) ||
    document.activeElement === document.body;
  row.remove();
  if (restoreFocus)
    (
      sessions.querySelector<HTMLElement>("[data-end-session] button") ??
      sessions.querySelector<HTMLElement>("h3")
    )?.focus({ preventScroll: true });
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
  const qr = setup.querySelector<HTMLElement>("[data-factor-qr]")!;
  try {
    // Generate locally: the setup URI contains the authenticator secret.
    const { default: QRCode } = await import("qrcode");
    // SVG does not depend on canvas, which some privacy settings disable.
    const svg = await QRCode.toString(result.totpURI, {
      type: "svg",
      width: 256,
      margin: 4,
      errorCorrectionLevel: "M",
    });
    const image = qr.querySelector<HTMLImageElement>("[data-factor-qr-image]")!;
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    await image.decode();
    qr.hidden = false;
  } catch {
    // Keep manual enrollment usable if the QR module or image is unavailable.
    qr.hidden = true;
    setup.querySelector<HTMLElement>("[data-factor-qr-error]")!.hidden = false;
  }
  setup.hidden = false;
  element.hidden = true;
});

async function refreshFactorSettings(element: HTMLFormElement) {
  // Verification and removal rotate the current session. Refresh its metadata
  // too, leaving unsaved profile answers untouched.
  const page = await loadActionPage();
  const settings = actionFragment(page, "[data-factor-settings]");
  const sessions = actionFragment(page, "[data-account-sessions]");
  const restoreFocus =
    element.contains(document.activeElement) ||
    document.activeElement === document.body;
  element.closest("[data-factor-settings]")!.replaceWith(settings);
  document.querySelector("[data-account-sessions]")!.replaceWith(sessions);
  if (restoreFocus)
    settings.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
  return settings;
}

form("[data-confirm-factor]", async (element, values) => {
  await authClient.twoFactor.verifyTotp({
    code: String(values.get("code")),
  });
  await refreshFactorSettings(element);
});

form("[data-disable-factor]", async (element, values) => {
  // The server requires the current TOTP and explicit confirmation in this same
  // request; a previous successful verification is not removal authorization.
  await post("/api/v1/auth/two-factor/disable", {
    code: String(values.get("code")),
    confirm: values.get("confirm") === "on",
  });
  const settings = await refreshFactorSettings(element);
  message(
    settings,
    "Your authenticator was removed. Two-factor protection is off. Set up and verify a new authenticator to turn it back on.",
    "success",
  );
});

export {};
