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

export function initAccountFormChanges(element: HTMLFormElement) {
  const button = element.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  // Profile answers are text and checkbox values; the server trims text on save.
  const snapshot = (values: FormData) =>
    JSON.stringify(
      [...values].map(([name, value]) => [name, String(value).trim()]),
    );
  let saved = snapshot(new FormData(element));
  const update = () => {
    if (button)
      button.disabled =
        Boolean(element.dataset.submitting) ||
        snapshot(new FormData(element)) === saved;
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
    },
  };
}
