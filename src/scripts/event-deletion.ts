import { createDialogHeader } from "./dialog";

let nextDeletionId = 0;

/** Series deletion confirmation before any write or email consent. */
export function confirmSeriesDeletion(): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog-pop dialog-frame volunteer-dialog";
  const heading = document.createElement("h2");
  heading.id = `event-deletion-${++nextDeletionId}`;
  heading.textContent = "Delete series?";
  dialog.setAttribute("aria-labelledby", heading.id);
  const { header, close } = createDialogHeader(heading);
  close.addEventListener("click", () => dialog.close());
  const content = document.createElement("div");
  content.className = "dialog-body";
  const description = document.createElement("p");
  description.id = `${heading.id}-description`;
  dialog.setAttribute("aria-describedby", description.id);
  description.textContent =
    "Remove this entire series and cancel all its future bookings? Registration and attendance history will be kept.";
  content.appendChild(description);
  const footer = document.createElement("div");
  footer.className = "dialog-footer";
  for (const [value, label, variant] of [
    ["delete", "Delete", "btn-red"],
    ["", "Keep", "btn-quiet"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${variant}`;
    button.textContent = label;
    button.autofocus = value === "";
    button.addEventListener("click", () => dialog.close(value));
    footer.appendChild(button);
  }
  for (const child of [header, content, footer]) dialog.appendChild(child);
  (document.querySelector(".volunteer-portal") ?? document.body).appendChild(
    dialog,
  );
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const confirmed = dialog.returnValue === "delete";
        dialog.remove();
        resolve(confirmed);
      },
      { once: true },
    );
    dialog.showModal();
  });
}
