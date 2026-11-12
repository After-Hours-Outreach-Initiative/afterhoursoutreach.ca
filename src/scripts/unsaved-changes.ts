// Save buttons of [data-track-changes] forms stay disabled until a value
// differs from the form as it was last loaded or saved.
const baselines = new WeakMap<HTMLFormElement, string>();

const formState = (form: HTMLFormElement) =>
  JSON.stringify(
    [...new FormData(form)].map(([name, value]) => [
      name,
      typeof value === "string" ? value : value.name,
    ]),
  );

const submitButtons = (form: HTMLFormElement) =>
  [...form.elements].filter(
    (control): control is HTMLButtonElement =>
      control instanceof HTMLButtonElement && control.type === "submit",
  );

export function syncUnsavedChanges(form: HTMLFormElement) {
  const baseline = baselines.get(form);
  if (baseline === undefined || form.dataset.submitting) return;
  const unchanged = formState(form) === baseline;
  for (const button of submitButtons(form)) button.disabled = unchanged;
}

/** Record the current values as saved. Keeps an existing draft's baseline
 * unless `reset` is set, such as after a successful save. */
export function trackUnsavedChanges(form: HTMLFormElement, reset = false) {
  if (reset || !baselines.has(form)) baselines.set(form, formState(form));
  syncUnsavedChanges(form);
}

const formOf = (target: EventTarget | null) =>
  target instanceof HTMLFormElement
    ? target
    : target instanceof Element
      ? ((target as HTMLInputElement).form ?? target.closest("form"))
      : null;

// Run after other handlers, which may enable or fill dependent fields.
const sync = (event: Event) => {
  const form = formOf(event.target);
  if (form?.matches("[data-track-changes]"))
    queueMicrotask(() => syncUnsavedChanges(form));
};
document.addEventListener("input", sync);
document.addEventListener("change", sync);
// Reset fires before the values are restored.
document.addEventListener("reset", (event) => {
  const form = formOf(event.target);
  if (form?.matches("[data-track-changes]"))
    setTimeout(() => syncUnsavedChanges(form));
});

/** The form's values as last loaded or saved, to tell which fields changed. */
export function savedFormValues(form: HTMLFormElement) {
  const baseline = baselines.get(form);
  if (baseline === undefined) return undefined;
  const values = new FormData();
  for (const [name, value] of JSON.parse(baseline) as [string, string][])
    values.append(name, value);
  return values;
}
