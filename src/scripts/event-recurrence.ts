const str = (values: FormData, key: string) => String(values.get(key) ?? "");

function eventFields(values: FormData) {
  return {
    meetingPoint: str(values, "meetingPoint"),
    meetingPointUrl: str(values, "meetingPointUrl"),
    spots: Number(values.get("spots")),
    includesOrientation: values.has("includesOrientation"),
    open: str(values, "publicVisibility") === "true",
    hidden: str(values, "publicVisibility") !== "true",
  };
}

export function recurringSaveAction(values: FormData) {
  const start = str(values, "startsAt");
  if (values.has("seriesId") && str(values, "scope") === "future") {
    const dayOffset =
      (Date.parse(`${start.slice(0, 10)}T00:00:00Z`) -
        Date.parse(`${str(values, "occurrenceDate")}T00:00:00Z`)) /
      86_400_000;
    return {
      action: "update-series-from",
      id: str(values, "seriesId"),
      version: Number(values.get("seriesVersion")),
      occurrenceDate: str(values, "occurrenceDate"),
      template: {
        ...eventFields(values),
        localTime: start.slice(11, 16),
        dayOffset,
      },
    };
  }
  if (values.has("recurring"))
    return {
      action: "save-series",
      series: {
        ...eventFields(values),
        firstDate: start.slice(0, 10),
        localTime: start.slice(11, 16),
        intervalWeeks: Number(values.get("intervalWeeks")),
        endDate: str(values, "endDate") || null,
      },
    };
  return null;
}

export function recurringCancelAction(values: FormData) {
  return values.has("seriesId") && str(values, "scope") === "future"
    ? {
        action: "stop-series",
        id: str(values, "seriesId"),
        version: Number(values.get("seriesVersion")),
        occurrenceDate: str(values, "occurrenceDate"),
        reason: str(values, "reason"),
      }
    : null;
}

export function seriesSaveAction(values: FormData) {
  const start = str(values, "startsAt");
  return {
    action: "save-series",
    id: str(values, "seriesId"),
    version: Number(values.get("version")),
    series: {
      ...eventFields(values),
      firstDate: start.slice(0, 10),
      localTime: start.slice(11, 16),
      intervalWeeks: Number(values.get("intervalWeeks")),
      endDate: str(values, "endDate") || null,
    },
  };
}

export function eventEmailPrompt(
  values: FormData,
  occurrencePrompt?: string,
  futurePrompt?: string,
) {
  return values.has("seriesId") && values.get("scope") === "future"
    ? futurePrompt
    : occurrencePrompt;
}

export function initRecurrenceControls(root: Document | HTMLElement) {
  for (const form of root.querySelectorAll<HTMLFormElement>(
    "[data-event-cancel]",
  )) {
    if (form.closest("[data-submitting]")) continue;
    const reason = form.querySelector<HTMLElement>(
      "[data-event-cancel-reason]",
    );
    const input = reason?.querySelector<HTMLTextAreaElement>("textarea");
    const heading = form.querySelector<HTMLElement>(
      "[data-event-cancel-heading]",
    );
    if (!reason || !input) continue;
    const update = () => {
      reason.hidden = !eventEmailPrompt(
        new FormData(form),
        form.dataset.emailPrompt,
        form.dataset.futureEmailPrompt,
      );
      if (heading) heading.hidden = reason.hidden;
      input.disabled = reason.hidden;
    };
    if (!form.dataset.cancelReasonReady) {
      form.dataset.cancelReasonReady = "true";
      form.querySelector('[name="scope"]')?.addEventListener("change", update);
      form.addEventListener("reset", () => queueMicrotask(update));
    }
    update();
  }
  for (const form of root.querySelectorAll<HTMLFormElement>(
    "[data-event-save], [data-series-save]",
  )) {
    if (form.dataset.submitting) continue;
    const orientation = form.querySelector<HTMLInputElement>(
      '[name="includesOrientation"]',
    );
    const spots = form.querySelector<HTMLInputElement>('[name="spots"]');
    const capacityFeedback = form.querySelector<HTMLElement>(
      '[data-error$="-spots"] span',
    );
    if (orientation && spots && capacityFeedback) {
      const updateCapacity = () => {
        spots.min = orientation.checked ? "4" : "2";
        capacityFeedback.textContent = orientation.checked
          ? "Enter a whole number from 4 to 100 for a patrol that includes orientation."
          : "Enter a whole number from 2 to 100.";
      };
      if (!form.dataset.capacityReady) {
        form.dataset.capacityReady = "true";
        orientation.addEventListener("change", updateCapacity);
        form.addEventListener("reset", () => queueMicrotask(updateCapacity));
      }
      updateCapacity();
    }
    const recurring =
      form.querySelector<HTMLInputElement>('[name="recurring"]');
    const controls = form.querySelector<HTMLElement>(
      "[data-recurrence-controls]",
    );
    const fields = form.querySelector<HTMLElement>("[data-recurrence-fields]");
    if (!recurring || !controls || !fields) continue;
    const endDate = fields.querySelector<HTMLInputElement>('[name="endDate"]')!;
    const start = form.querySelector<HTMLInputElement>('[name="startsAt"]')!;
    const update = () => {
      fields.hidden = !recurring.checked;
      for (const input of fields.querySelectorAll<HTMLInputElement>("input"))
        input.disabled = fields.hidden;
      endDate.min = start.value.slice(0, 10);
    };
    if (!form.dataset.recurrenceReady) {
      form.dataset.recurrenceReady = "true";
      recurring.addEventListener("change", update);
      form
        .querySelector('[data-date-input="startsAt"]')
        ?.addEventListener("input", update);
      form
        .querySelector('[data-date-input="startsAt"]')
        ?.addEventListener("change", update);
      form.addEventListener("reset", () => queueMicrotask(update));
    }
    update();
  }
}

/** Reconcile only this card's settings; occurrences have independent live state. */
export function syncSeriesControls(
  card: HTMLElement,
  updatedCard: HTMLElement,
  element?: HTMLFormElement,
) {
  const current = card.querySelector<HTMLDetailsElement>("[data-live-series]")!;
  const updated =
    updatedCard.querySelector<HTMLDetailsElement>("[data-live-series]")!;
  if (current.dataset.seriesVersion === updated.dataset.seriesVersion)
    return false;
  const savedSettings =
    current.contains(element ?? null) &&
    element?.matches("[data-series-save], [data-event-delete]");
  if (
    (current.open && !savedSettings) ||
    [...current.querySelectorAll('[data-submitting="true"]')].some(
      (form) => form !== element,
    )
  )
    return true;
  const replacement = document.importNode(updated, true);
  replacement.open = current.open;
  current.replaceWith(replacement);
  return false;
}
