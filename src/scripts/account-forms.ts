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
