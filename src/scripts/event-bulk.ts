interface SelectedEvent {
  id: string;
  version: number;
  label: string;
}
const selections = new WeakMap<HTMLElement, Map<string, SelectedEvent>>();
const selectedFor = (root: HTMLElement) => {
  let selected = selections.get(root);
  if (!selected) selections.set(root, (selected = new Map()));
  return selected;
};
const checkboxes = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLInputElement>("[data-bulk-event]"),
];
const shown = (input: HTMLInputElement) =>
  !input.closest("[hidden], details:not([open])") &&
  input.getClientRects().length > 0;
const target = (input: HTMLInputElement): SelectedEvent => ({
  id: input.dataset.bulkEvent!,
  version: Number(input.dataset.bulkVersion),
  label: input.dataset.bulkLabel!,
});
const versions = (rows: SelectedEvent[]) =>
  JSON.stringify(rows.map(({ id, version }) => ({ id, version })));

export function bulkEventAction(values: FormData) {
  const changes: Record<string, string | number | boolean> = {};
  for (const name of [
    "meetingPoint",
    "meetingPointUrl",
    "spots",
    "includesOrientation",
    "open",
    "hidden",
  ]) {
    const value = values.get(name);
    if (
      value === null ||
      (["includesOrientation", "open", "hidden"].includes(name) && value === "")
    )
      continue;
    changes[name] =
      name === "spots"
        ? Number(value)
        : ["includesOrientation", "open", "hidden"].includes(name)
          ? value === "true"
          : String(value);
  }
  return {
    action: "bulk-save",
    selection: JSON.parse(String(values.get("selection"))),
    changes,
  };
}

/** Keep only visible, still-current targets. Never silently upgrade edit versions. */
export function syncBulkEventSelection(root: HTMLElement) {
  const count = root.querySelector<HTMLElement>("[data-bulk-count]");
  if (!count) return;
  const selected = selectedFor(root);
  const inputs = checkboxes(root);
  let removed = false;
  for (const [id, row] of selected) {
    const input = inputs.find((input) => input.dataset.bulkEvent === id);
    if (
      !input ||
      !shown(input) ||
      Number(input.dataset.bulkVersion) !== row.version ||
      Number(
        input.closest<HTMLElement>("[data-event-start]")?.dataset.eventStart,
      ) <= Date.now()
    ) {
      selected.delete(id);
      removed = true;
    }
  }
  for (const input of inputs)
    input.checked = selected.has(input.dataset.bulkEvent!);
  const summary = `${selected.size} selected${removed ? ". Changed or hidden selections were cleared." : ""}`;
  if (count.textContent !== summary) count.textContent = summary;
  root.querySelector<HTMLButtonElement>("[data-bulk-open]")!.disabled =
    selected.size === 0;
  root.querySelector<HTMLButtonElement>("[data-bulk-clear]")!.disabled =
    selected.size === 0;
  root.querySelector<HTMLButtonElement>("[data-bulk-select-all]")!.disabled =
    !inputs.some(shown);
  const form = root.querySelector<HTMLFormElement>("[data-bulk-event-save]")!;
  if (form.closest<HTMLDialogElement>("dialog")!.open) {
    const snapshot =
      form.querySelector<HTMLInputElement>('[name="selection"]')!.value;
    const stale = snapshot !== versions([...selected.values()]);
    form.querySelector<HTMLElement>("[data-bulk-stale]")!.hidden = !stale;
    const button = root.querySelector<HTMLButtonElement>(
      '[form="bulk-event-save"][type="submit"]',
    )!;
    button.disabled =
      stale ||
      Boolean(form.dataset.submitting) ||
      Object.keys(bulkEventAction(new FormData(form)).changes).length === 0;
  }
}

export function clearBulkEventSelection(root: HTMLElement) {
  selectedFor(root).clear();
  syncBulkEventSelection(root);
}

export function initBulkEvents(root: HTMLElement) {
  if (!root.querySelector("[data-bulk-actions]")) return;
  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-bulk-clear]"))
      clearBulkEventSelection(root);
    if (event.target.closest("[data-bulk-select-all]")) {
      const selected = selectedFor(root);
      for (const input of checkboxes(root).filter(shown))
        selected.set(input.dataset.bulkEvent!, target(input));
      syncBulkEventSelection(root);
    }
    if (event.target.closest("[data-bulk-open]")) {
      syncBulkEventSelection(root);
      const selected = [...selectedFor(root).values()];
      if (!selected.length) return;
      const dialog =
        root.querySelector<HTMLDialogElement>("#bulk-event-editor")!;
      if (dialog.dataset.submitting) return;
      const form = dialog.querySelector<HTMLFormElement>("form")!;
      form.reset();
      form.querySelector<HTMLElement>("[data-form-message]")!.hidden = true;
      form.querySelector<HTMLInputElement>('[name="selection"]')!.value =
        versions(selected);
      for (const name of ["meetingPoint", "meetingPointUrl", "spots"])
        form.querySelector<HTMLInputElement>(`[name="${name}"]`)!.disabled =
          true;
      dialog.querySelector("[data-bulk-summary]")!.textContent =
        `${selected.length} selected ${selected.length === 1 ? "event" : "events"}`;
      dialog.querySelector("[data-bulk-targets]")!.replaceChildren(
        ...selected.map((row) => {
          const li = document.createElement("li");
          li.textContent = row.label;
          return li;
        }),
      );
      dialog.showModal();
      syncBulkEventSelection(root);
    }
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (!(
      input instanceof HTMLInputElement || input instanceof HTMLSelectElement
    ))
      return;
    if (
      input instanceof HTMLInputElement &&
      input.matches("[data-bulk-event]")
    ) {
      if (input.checked && shown(input))
        selectedFor(root).set(input.dataset.bulkEvent!, target(input));
      else selectedFor(root).delete(input.dataset.bulkEvent!);
    }
    if (input instanceof HTMLInputElement && input.dataset.bulkEnable) {
      input.form!.querySelector<HTMLInputElement>(
        `[name="${input.dataset.bulkEnable}"]`,
      )!.disabled = !input.checked;
    }
    syncBulkEventSelection(root);
  });
  // Collapsed series occurrences are not "shown" and cannot remain hidden targets.
  root.addEventListener(
    "cancel",
    (event) => {
      if (
        event.target instanceof HTMLDialogElement &&
        event.target.id === "bulk-event-editor" &&
        event.target.dataset.submitting
      )
        event.preventDefault();
    },
    true,
  );
  root.addEventListener(
    "toggle",
    (event) => {
      if (
        event.target instanceof HTMLDetailsElement &&
        event.target.matches("[data-series-occurrences]")
      )
        syncBulkEventSelection(root);
    },
    true,
  );
  syncBulkEventSelection(root);
}
