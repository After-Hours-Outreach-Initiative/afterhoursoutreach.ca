import { createDialogHeader } from "./dialog";

export type SaveScope = "occurrence" | "future" | "all";

let nextPromptId = 0;

/** Like Google Calendar, ask which dates a recurring edit applies to after Save. */
export function chooseSeriesScope(
  form: HTMLFormElement,
  scheduleChanged: boolean,
): Promise<SaveScope | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog-pop dialog-frame volunteer-dialog";
  const heading = document.createElement("h2");
  heading.id = `series-scope-${++nextPromptId}`;
  heading.textContent = "Edit recurring event";
  dialog.setAttribute("aria-labelledby", heading.id);
  const { header, close } = createDialogHeader(heading);
  close.addEventListener("click", () => dialog.close());
  const body = document.createElement("form");
  body.className = "dialog-body volunteer-form";
  body.method = "dialog";
  body.id = `${heading.id}-form`;
  const fieldset = document.createElement("fieldset");
  fieldset.className = "volunteer-radio-field";
  const legend = document.createElement("legend");
  legend.textContent = "Apply changes to";
  const group = document.createElement("div");
  group.className = "volunteer-radio-group";
  const options: [SaveScope, string][] = [
    ["occurrence", "This event"],
    ["future", "This and following events"],
    ["all", "All events"],
  ];
  for (const [value, text] of options) {
    const label = document.createElement("label");
    label.className = "volunteer-check";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "scope";
    input.value = value;
    input.disabled = scheduleChanged && value === "occurrence";
    input.checked = value === (scheduleChanged ? "future" : "occurrence");
    const span = document.createElement("span");
    span.textContent = text;
    for (const child of [input, span]) label.appendChild(child);
    group.appendChild(label);
  }
  for (const child of [legend, group]) fieldset.appendChild(child);
  body.appendChild(fieldset);
  if (scheduleChanged) {
    const note = document.createElement("p");
    note.className = "volunteer-help";
    note.id = `${heading.id}-note`;
    note.textContent =
      "You changed the repeat schedule, so this applies to this and following events, or all events.";
    fieldset.setAttribute("aria-describedby", note.id);
    body.appendChild(note);
  }
  const footer = document.createElement("div");
  footer.className = "dialog-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-quiet";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close());
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn btn-primary";
  save.textContent = "Save";
  save.setAttribute("form", body.id);
  for (const child of [cancel, save]) footer.appendChild(child);
  let choice: SaveScope | null = null;
  body.addEventListener("submit", (event) => {
    event.preventDefault();
    choice = new FormData(body).get("scope") as SaveScope;
    dialog.close();
  });
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
  for (const child of [header, body, footer]) dialog.appendChild(child);
  (form.closest(".volunteer-portal") ?? document.body).appendChild(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        resolve(choice);
      },
      { once: true },
    );
    dialog.showModal();
    group.querySelector<HTMLInputElement>("input:checked")?.focus();
  });
}
