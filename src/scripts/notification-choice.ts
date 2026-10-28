import { createDialogHeader } from "./dialog";

let nextChoiceId = 0;

const descriptions: Record<string, string> = {
  bulk: "You can email the volunteers registered for the selected events whose details change. Other occurrences and entire recurring series are not changed or emailed.",
  access:
    "You can email this volunteer about their updated access. If this change cancels any future spots, their cancellation emails will be included too.",
  role: "You can email this volunteer about their new role and ask them to sign in again.",
  signup:
    "You can email this volunteer about the moved or removed registration, including any reason you entered.",
  event:
    "You can email the volunteers registered for this event about the updated details.",
  "event-cancel":
    "You can email the volunteers registered for this event about its cancellation, including any reason you entered.",
  series:
    "You can email the volunteers whose booked patrol occurrences change. Individual exceptions keep their own details and are not emailed.",
  "series-cancel":
    "You can email the volunteers whose future patrol bookings are cancelled, including any reason you entered. Past occurrences are not changed.",
};

/** Consent is collected before the write so skipped emails are never queued. */
export function chooseNotification(kind: string): Promise<boolean | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog-pop dialog-frame volunteer-dialog";
  const heading = document.createElement("h2");
  heading.id = `notification-choice-${++nextChoiceId}`;
  heading.textContent = "Send an email?";
  dialog.setAttribute("aria-labelledby", heading.id);
  const { header, close } = createDialogHeader(heading);
  close.addEventListener("click", () => dialog.close());
  const content = document.createElement("div");
  content.className = "dialog-body";
  const description = document.createElement("p");
  description.id = `${heading.id}-description`;
  dialog.setAttribute("aria-describedby", description.id);
  description.className = "volunteer-help";
  description.textContent =
    descriptions[kind] ??
    "You can email the affected volunteers about this change.";
  const actions = document.createElement("div");
  actions.className = "dialog-footer";
  for (const [value, label, variant] of [
    ["skip", "Save without email", "btn-primary"],
    ["send", "Save and send email", "btn-outline"],
    ["", "Cancel change", "btn-quiet"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${variant}`;
    button.textContent = label;
    button.autofocus = value === "skip";
    button.addEventListener("click", () => dialog.close(value));
    actions.appendChild(button);
  }
  content.appendChild(description);
  for (const child of [header, content, actions]) dialog.appendChild(child);
  // Keep site styles and native dialog focus handling, including inside another modal.
  (document.querySelector(".volunteer-portal") ?? document.body).appendChild(
    dialog,
  );
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const choice = dialog.returnValue;
        dialog.remove();
        resolve(choice === "send" ? true : choice === "skip" ? false : null);
      },
      { once: true },
    );
    dialog.showModal();
  });
}
