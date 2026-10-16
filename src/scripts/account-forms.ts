import {
  applicationBirthDateError,
  countWords,
  motivationMaxWords,
  motivationWordLimitError,
} from "../data/application";
import { profileSummaryRows } from "../data/account-profile";

const requestFailed = "The request failed. Please try again.";

export function accountErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return requestFailed;
  const failure = error as {
    status?: number;
    statusText?: string;
    message?: string;
    error?: { message?: string };
  };
  // Better Fetch puts the API's message in `error`; Error.message can be just "429".
  const detail = failure.error?.message;
  if (detail && !/^\d{3}$/.test(detail)) return detail;
  if (failure.status === 429)
    return "Too many requests. Please wait before trying again.";
  if (failure.status && failure.status >= 500)
    return "This service is temporarily unavailable. Please try again later.";
  if (error instanceof TypeError)
    return "We could not connect. Check your connection and try again.";
  if (
    failure.message &&
    !/^\d{3}$/.test(failure.message) &&
    failure.message !== failure.statusText
  )
    return failure.message;
  return requestFailed;
}

export function showFormMessage(
  element: Element,
  text: string,
  kind: "error" | "success" = "error",
) {
  const target = element.querySelector<HTMLElement>("[data-form-message]");
  if (!target) return;
  target.dataset.messageKind = kind;
  target.setAttribute("role", kind === "error" ? "alert" : "status");
  target.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  target.textContent = text;
  target.hidden = false;
}

export function clearFormMessage(element: Element) {
  const target = element.querySelector<HTMLElement>("[data-form-message]");
  if (!target) return;
  target.hidden = true;
  target.textContent = "";
  delete target.dataset.messageKind;
}

export function initBirthDate(element: HTMLFormElement) {
  const input = element.querySelector<HTMLInputElement>('[name="birthDate"]');
  if (!input?.max) return;
  const latest = Date.parse(input.max);
  // Android opens an empty picker at min (1900) when max is before today.
  // Keep the age limit in validation, not the calendar, without pre-filling a birthday.
  // The server-rendered max remains the fallback when JavaScript is disabled.
  input.removeAttribute("max");
  const update = () => {
    input.setCustomValidity(
      input.valueAsNumber > latest ? applicationBirthDateError : "",
    );
  };
  input.addEventListener("input", update);
  input.addEventListener("change", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}

export function initMedicCertifications(element: HTMLFormElement) {
  const section = element.querySelector<HTMLElement>(
    "[data-medic-certifications]",
  );
  const medic = element.querySelector<HTMLInputElement>(
    '[name="teams"][value="medic"]',
  );
  if (!section || !medic) return;
  const fields = [
    ...section.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ];
  const other = section.querySelector<HTMLInputElement>('[value="other"]');
  const training = element.querySelector<HTMLElement>("[data-other-training]");
  const experience = training?.querySelector<HTMLTextAreaElement>("textarea");
  const expiry = element.querySelector<HTMLElement>(
    "[data-certification-expiry]",
  );
  const expiryInput = expiry?.querySelector<HTMLInputElement>("input");
  const update = () => {
    section.hidden = !medic.checked;
    // Retain checked answers in FormData and drafts without hidden validation.
    for (const field of fields) field.required = medic.checked;
    if (expiry && expiryInput) {
      expiry.hidden = !medic.checked;
      expiryInput.required = medic.checked;
      expiryInput.readOnly = !medic.checked;
    }
    if (training && experience) {
      const active = medic.checked && Boolean(other?.checked);
      training.hidden = !active;
      experience.required = active;
      experience.readOnly = !active;
      experience.setCustomValidity(
        active && !experience.value.trim()
          ? "Describe your other training and experience."
          : "",
      );
    }
  };
  medic.addEventListener("change", update);
  section.addEventListener("change", update);
  experience?.addEventListener("input", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}

export function initRelevantTraining(element: HTMLFormElement) {
  const other = element.querySelector<HTMLInputElement>(
    '[name="training"][value="other"]',
  );
  const details = element.querySelector<HTMLElement>(
    "[data-other-relevant-training]",
  );
  const input = details?.querySelector<HTMLTextAreaElement>("textarea");
  if (!other || !details || !input) return;
  const update = () => {
    details.hidden = !other.checked;
    input.required = other.checked;
    input.readOnly = !other.checked;
    input.setCustomValidity(
      other.checked && !input.value.trim()
        ? "Describe your other relevant training or experience."
        : "",
    );
  };
  other.addEventListener("change", update);
  input.addEventListener("input", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}

export function initReferralSources(element: HTMLFormElement) {
  const section = element.querySelector<HTMLElement>("[data-referral-sources]");
  const choices = [
    ...(section?.querySelectorAll<HTMLInputElement>(
      '[name="heardAboutUsSources"]',
    ) ?? []),
  ];
  const first = choices[0];
  const other = choices.find((choice) => choice.value === "other");
  const details = section?.querySelector<HTMLElement>("[data-other-referral]");
  const input = details?.querySelector<HTMLInputElement>("input");
  if (!section || !first || !other || !details || !input) return;
  const update = () => {
    const selected = choices.some((choice) => choice.checked);
    first.required = !selected;
    first.setCustomValidity(
      selected ? "" : "Select at least one way you found out about us.",
    );
    details.hidden = !other.checked;
    input.required = other.checked;
    input.disabled = !other.checked;
    if (!other.checked) input.value = "";
    input.setCustomValidity(
      other.checked && !input.value.trim()
        ? "Briefly describe how you found out about us."
        : "",
    );
  };
  section.addEventListener("change", update);
  input.addEventListener("input", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}

export function initMotivationWordLimit(element: HTMLFormElement) {
  const input = element.querySelector<HTMLTextAreaElement>(
    'textarea[name="motivation"]',
  );
  const feedback = element.querySelector<HTMLElement>(
    '[data-error="motivation"] span',
  );
  if (!input) return;
  const update = () => {
    const words = countWords(input.value);
    const over = words - motivationMaxWords;
    const error =
      input.required && words === 0
        ? "This field is required."
        : over > 0
          ? motivationWordLimitError
          : "";
    input.setCustomValidity(input.readOnly ? "" : error);
    if (over > 0 && !input.readOnly) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    if (feedback) feedback.textContent = error || "This field is required.";
  };
  input.addEventListener("input", update);
  input.addEventListener("change", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}

export function initAccountFormChanges(element: HTMLFormElement) {
  const button = element.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  const view = element.querySelector<HTMLElement>("[data-profile-view]")!;
  const editor = element.querySelector<HTMLElement>("[data-profile-editor]")!;
  const edit = element.querySelector<HTMLButtonElement>("[data-profile-edit]")!;
  const cancel = element.querySelector<HTMLButtonElement>(
    "[data-profile-cancel]",
  )!;
  // Profile answers are text and checkbox values; the server trims text on save.
  const snapshot = (values: FormData) =>
    JSON.stringify(
      [...values].map(([name, value]) => [name, String(value).trim()]),
    );
  let saved = snapshot(new FormData(element));
  const changed = () => snapshot(new FormData(element)) !== saved;
  const setEditing = (editing: boolean) => {
    const restoreFocus =
      editor.contains(document.activeElement) ||
      document.activeElement === document.body;
    view.hidden = editing;
    editor.hidden = !editing;
    edit.setAttribute("aria-expanded", String(editing));
    if (editing) {
      clearFormMessage(element);
      editor
        .querySelector<HTMLElement>(
          'input:not([type="hidden"]):enabled:not([readonly])',
        )
        ?.focus();
    } else if (restoreFocus) edit.focus({ preventScroll: true });
  };
  edit.disabled = false;
  edit.addEventListener("click", () => setEditing(true));
  cancel.addEventListener("click", () => {
    if (element.dataset.submitting) return;
    element.reset();
    clearFormMessage(element);
    setEditing(false);
  });
  const update = () => {
    if (button)
      button.disabled = Boolean(element.dataset.submitting) || !changed();
    cancel.disabled = Boolean(element.dataset.submitting);
  };
  for (const event of ["input", "change"])
    element.addEventListener(event, update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
  return {
    update,
    markSaved(values: FormData) {
      // Edits made while the request is pending must remain unsaved.
      saved = snapshot(values);
      // Cancel/reset must return to the latest save, not the initial page load.
      for (const control of element.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >("input[name], textarea[name]")) {
        if (
          control instanceof HTMLInputElement &&
          ["radio", "checkbox"].includes(control.type)
        ) {
          const checked = control.checked;
          control.defaultChecked = control.disabled
            ? checked
            : values.getAll(control.name).includes(control.value);
          control.checked = checked;
        } else {
          const value = control.value;
          control.defaultValue = String(values.get(control.name) ?? "").trim();
          control.value = value;
        }
      }
      const answers = {
        ...Object.fromEntries(
          [...values].map(([name, value]) => [name, String(value)]),
        ),
        teams: values.getAll("teams").map(String),
        certifications: values.getAll("certifications").map(String),
        training: values.getAll("training").map(String),
      };
      for (const row of profileSummaryRows(answers)) {
        const target = view.querySelector<HTMLElement>(
          `[data-profile-row="${row.name}"]`,
        )!;
        target.hidden = row.hidden;
        const answer = target.querySelector<HTMLElement>("dd")!;
        if (Array.isArray(row.value) && row.value.length) {
          const list = document.createElement("ul");
          for (const value of row.value) {
            const item = document.createElement("li");
            item.textContent = value;
            list.appendChild(item);
          }
          answer.replaceChildren(list);
        } else
          answer.textContent = Array.isArray(row.value)
            ? "None selected"
            : row.value;
      }
      if (!changed()) setEditing(false);
    },
  };
}
