interface SelectedEvent {
  id: string;
  version: number;
  day: string;
  time: string;
  place: string;
  recurring: boolean;
  values: Record<string, string>;
}
const numberFields = [
  "spots",
  "minMedicSpots",
  "minNewVolunteerSpots",
  "maxNewVolunteers",
  "unregisterMinutes",
];
const booleanFields = ["includesOrientation", "publicVisibility"];
const fields = [
  "startTime",
  "meetingPoint",
  "meetingPointUrl",
  ...numberFields,
  ...booleanFields,
];
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
  day: input.dataset.bulkDay!,
  time: input.dataset.bulkTime!,
  place: input.dataset.bulkPlace!,
  recurring: "bulkRecurring" in input.dataset,
  values: JSON.parse(input.dataset.bulkValues!),
});
const versions = (rows: SelectedEvent[]) =>
  JSON.stringify(rows.map(({ id, version }) => ({ id, version })));

/** Send only fields that differ from the value every selected event shares.
 * A blank field whose events vary stays unchanged. */
export function bulkEventAction(values: FormData) {
  const initial: Record<string, string | null> = JSON.parse(
    String(values.get("initial") || "{}"),
  );
  const changes: Record<string, string | number | boolean> = {};
  for (const name of fields) {
    const value = String(values.get(name) ?? "");
    const shared = initial[name] ?? null;
    if (shared === null ? value === "" : value === shared) continue;
    // Visibility also controls registration, matching the single event editor.
    if (name === "publicVisibility") {
      changes.open = value === "true";
      changes.hidden = value !== "true";
      continue;
    }
    changes[name] = numberFields.includes(name)
      ? Number(value)
      : booleanFields.includes(name)
        ? value === "true"
        : value;
  }
  return {
    action: "bulk-save",
    selection: JSON.parse(String(values.get("selection"))),
    changes,
  };
}

function fillBulkForm(dialog: HTMLDialogElement, selected: SelectedEvent[]) {
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  form.reset();
  form.querySelector<HTMLElement>("[data-form-message]")!.hidden = true;
  form.querySelector<HTMLInputElement>('[name="selection"]')!.value =
    versions(selected);
  const initial: Record<string, string | null> = {};
  for (const name of fields) {
    const values = new Set(selected.map((row) => row.values[name]));
    const shared = values.size === 1 ? [...values][0] : null;
    initial[name] = shared;
    if (booleanFields.includes(name)) {
      for (const radio of form.querySelectorAll<HTMLInputElement>(
        `[name="${name}"]`,
      ))
        radio.checked = radio.value === shared;
      continue;
    }
    const control = form.elements.namedItem(name) as HTMLInputElement;
    control.placeholder =
      shared === null ? "Varies" : name === "meetingPointUrl" ? "https://" : "";
    control.required = shared !== null && name !== "meetingPointUrl";
    control.value = shared ?? "";
  }
  form.querySelector<HTMLInputElement>('[name="initial"]')!.value =
    JSON.stringify(initial);
  form.querySelector("[data-bulk-time-help]")!.textContent =
    initial.startTime === null
      ? "Start times vary. Each event keeps its date."
      : "Each event keeps its date.";
  dialog.querySelector("[data-bulk-summary]")!.textContent =
    `${selected.length} selected ${selected.length === 1 ? "event" : "events"}`;
  const template = dialog.querySelector<HTMLTemplateElement>(
    "[data-bulk-target-template]",
  )!;
  dialog.querySelector("[data-bulk-targets]")!.replaceChildren(
    ...selected.map((row) => {
      const card = template.content.firstElementChild!.cloneNode(
        true,
      ) as HTMLElement;
      card.querySelector("[data-day]")!.textContent = row.day;
      card.querySelector("[data-time]")!.textContent = row.time;
      card.querySelector("[data-place]")!.textContent = row.place;
      if (!row.recurring) card.querySelector("[data-recurring]")!.remove();
      return card;
    }),
  );
}

/** Keep only visible, still-current targets. Never silently upgrade edit versions. */
export function syncBulkEventSelection(root: HTMLElement) {
  const count = root.querySelector<HTMLElement>("[data-bulk-count]");
  if (!count) return;
  // Selection mode lives on the root so it survives refreshed cards and toolbars.
  const selecting = "bulkSelecting" in root.dataset;
  root.querySelector<HTMLElement>("[data-bulk-actions]")!.hidden = !selecting;
  for (const toggle of root.querySelectorAll("[data-bulk-select-mode]")) {
    toggle.setAttribute("aria-pressed", String(selecting));
    toggle.textContent = selecting ? "Cancel" : "Select";
  }
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
    !inputs.some(
      (input) => shown(input) && !selected.has(input.dataset.bulkEvent!),
    );
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

function setBulkEventSelecting(root: HTMLElement, selecting: boolean) {
  selectedFor(root).clear();
  if (selecting) root.dataset.bulkSelecting = "";
  else delete root.dataset.bulkSelecting;
  syncBulkEventSelection(root);
}

export function initBulkEvents(root: HTMLElement) {
  if (!root.querySelector("[data-bulk-actions]")) return;
  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-bulk-select-mode]"))
      setBulkEventSelecting(root, !("bulkSelecting" in root.dataset));
    if (event.target.closest("[data-bulk-exit]")) {
      setBulkEventSelecting(root, false);
      root
        .querySelector<HTMLButtonElement>("[data-bulk-select-mode]")
        ?.focus({ preventScroll: true });
    }
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
      fillBulkForm(dialog, selected);
      dialog.showModal();
      syncBulkEventSelection(root);
    }
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.matches("[data-bulk-event]")) {
      if (input.checked && shown(input))
        selectedFor(root).set(input.dataset.bulkEvent!, target(input));
      else selectedFor(root).delete(input.dataset.bulkEvent!);
    }
    syncBulkEventSelection(root);
  });
  root.addEventListener("input", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-bulk-event-save]")
    )
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
  syncBulkEventSelection(root);
}
