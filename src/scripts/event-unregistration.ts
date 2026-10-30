import { createDialogHeader } from "./dialog";

let nextUnregistrationId = 0;

export function confirmEventUnregistration(
  form: HTMLFormElement,
): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog-pop dialog-frame volunteer-dialog";
  const heading = document.createElement("h2");
  heading.id = `event-unregistration-${++nextUnregistrationId}`;
  heading.textContent = "Unregister from this event?";
  dialog.setAttribute("aria-labelledby", heading.id);
  const { header, close } = createDialogHeader(heading);
  close.addEventListener("click", () => dialog.close());
  const content = document.createElement("div");
  content.className = "dialog-body";
  const description = document.createElement("p");
  description.id = `${heading.id}-description`;
  dialog.setAttribute("aria-describedby", description.id);
  const card = form.closest<HTMLElement>("[data-live-event]");
  const label = card?.querySelector("h3")?.textContent?.trim();
  description.textContent = `Your registration for ${label || "this event"} will be removed.`;
  content.appendChild(description);
  const footer = document.createElement("div");
  footer.className = "dialog-footer";
  for (const [value, label, variant] of [
    ["unregister", "Unregister", "btn-red"],
    ["", "Cancel", "btn-quiet"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${variant}`;
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
        const confirmed = dialog.returnValue === "unregister";
        dialog.remove();
        resolve(confirmed);
      },
      { once: true },
    );
    dialog.showModal();
  });
}
