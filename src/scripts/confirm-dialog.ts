import { createDialogHeader } from "./dialog";

let nextConfirmId = 0;

/** A modal yes/no question, resolving true only when the action is confirmed. */
export function confirmAction(
  form: HTMLFormElement,
  {
    title,
    description,
    confirmLabel,
    variant = "btn-primary",
  }: {
    title: string;
    description: string;
    confirmLabel: string;
    variant?: string;
  },
): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog-pop dialog-frame volunteer-dialog";
  const heading = document.createElement("h2");
  heading.id = `confirm-action-${++nextConfirmId}`;
  heading.textContent = title;
  dialog.setAttribute("aria-labelledby", heading.id);
  const { header, close } = createDialogHeader(heading);
  close.addEventListener("click", () => dialog.close());
  const content = document.createElement("div");
  content.className = "dialog-body";
  const text = document.createElement("p");
  text.id = `${heading.id}-description`;
  dialog.setAttribute("aria-describedby", text.id);
  text.textContent = description;
  content.appendChild(text);
  const footer = document.createElement("div");
  footer.className = "dialog-footer";
  for (const [value, label, style] of [
    ["", "Cancel", "btn-quiet"],
    ["confirm", confirmLabel, variant],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${style}`;
    button.textContent = label;
    button.autofocus = value === "";
    button.addEventListener("click", () => dialog.close(value));
    footer.appendChild(button);
  }
  // The playground uses this same dialog without the portal's click handler.
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
  for (const child of [header, content, footer]) dialog.appendChild(child);
  (form.closest(".volunteer-portal") ?? document.body).appendChild(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const confirmed = dialog.returnValue === "confirm";
        dialog.remove();
        resolve(confirmed);
      },
      { once: true },
    );
    dialog.showModal();
  });
}

const eventLabel = (form: HTMLFormElement) =>
  form
    .closest<HTMLElement>("[data-live-event]")
    ?.querySelector("h3")
    ?.textContent?.trim() || "this event";

export const confirmEventUnregistration = (form: HTMLFormElement) =>
  confirmAction(form, {
    title: "Unregister from this event?",
    description: `Your registration for ${eventLabel(form)} will be removed.`,
    confirmLabel: "Unregister",
    variant: "btn-red",
  });

export const confirmEventRestore = (form: HTMLFormElement) =>
  confirmAction(form, {
    title: "Restore this event?",
    description: `${eventLabel(form)} comes back with the series' current details. Earlier registrations stay cancelled, so volunteers need to register again.`,
    confirmLabel: "Restore",
  });
