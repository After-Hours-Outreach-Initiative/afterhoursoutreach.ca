type FormControl = HTMLInputElement | HTMLTextAreaElement;

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

export function resetFormFeedback(element: HTMLFormElement) {
  clearFormMessage(element);
  delete element.dataset.validationAttempted;
  element.querySelectorAll<HTMLElement>("[data-error]").forEach((target) => {
    target.hidden = true;
    const text = target.querySelector("span");
    if (text) text.textContent = "";
  });
  element.querySelectorAll("[aria-invalid]").forEach((control) => {
    control.removeAttribute("aria-invalid");
  });
}

function fieldMessage(control: FormControl): string {
  if (control instanceof HTMLInputElement && control.type === "checkbox")
    return control.required && !control.checked
      ? (control.dataset.validationMessage ?? "This field is required.")
      : "";
  const value = control.value.trim();
  const validity = control.validity;
  if (validity.badInput) return "Enter a valid value.";
  if (control.required && !value) return "This field is required.";
  if (value && control instanceof HTMLInputElement && control.type === "tel") {
    if (value.length < 7 || !/^[\d+().\s\-x]+$/i.test(value))
      return "Enter a valid phone number with at least 7 characters.";
  }
  if (validity.typeMismatch) return "Enter a valid email address.";
  if (validity.patternMismatch)
    return control.dataset.validationMessage ?? "Enter a valid value.";
  if (validity.rangeUnderflow || validity.rangeOverflow)
    return "Choose a date of birth between January 1, 1900 and today.";
  return validity.valid ? "" : control.validationMessage;
}

function setFieldError(
  element: HTMLFormElement,
  field: string,
  controls: HTMLElement[],
  text: string,
) {
  const target = [
    ...element.querySelectorAll<HTMLElement>("[data-error]"),
  ].find((target) => target.dataset.error === field);
  if (target) {
    const content = target.querySelector("span");
    if (content) content.textContent = text;
    target.hidden = !text;
  }
  for (const control of controls) {
    if (text) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  }
}

export function validateAccountForm(element: HTMLFormElement, focus = true) {
  element.dataset.validationAttempted = "true";
  let firstInvalid: HTMLElement | undefined;
  const controls = element.querySelectorAll<FormControl>("input, textarea");
  for (const control of controls) {
    if (
      !control.willValidate ||
      (control.type === "checkbox" && !control.required)
    )
      continue;
    const text = fieldMessage(control);
    setFieldError(
      element,
      control.dataset.errorField ?? control.name,
      [control],
      text,
    );
    if (text) firstInvalid ??= control;
  }
  for (const group of element.querySelectorAll<HTMLElement>(
    "[data-required-checkboxes]",
  )) {
    const boxes = [
      ...group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    const text = boxes.some((box) => box.checked)
      ? ""
      : "Choose at least one team.";
    setFieldError(
      element,
      group.dataset.requiredCheckboxes!,
      [group, ...boxes],
      text,
    );
    const firstBox = boxes[0];
    if (
      text &&
      firstBox &&
      (!firstInvalid ||
        firstBox.compareDocumentPosition(firstInvalid) &
          Node.DOCUMENT_POSITION_FOLLOWING)
    )
      firstInvalid = firstBox;
  }
  if (firstInvalid) {
    showFormMessage(element, "Please correct the highlighted fields.");
    if (focus) firstInvalid.focus();
    return false;
  }
  clearFormMessage(element);
  return true;
}

export function initAccountFormValidation(element: HTMLFormElement) {
  // Keep native constraints, but replace the browser's single-field popup with inline errors.
  element.noValidate = true;
  for (const event of ["input", "change"]) {
    element.addEventListener(event, () => {
      if (element.dataset.validationAttempted)
        validateAccountForm(element, false);
    });
  }
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
