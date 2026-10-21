const str = (values: FormData, key: string) => String(values.get(key) ?? "");

function eventFields(values: FormData) {
  return {
    meetingPoint: str(values, "meetingPoint"),
    meetingPointUrl: str(values, "meetingPointUrl"),
    spots: Number(values.get("spots")),
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
  if (values.has("recurring") && str(values, "type") === "patrol")
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

export function seriesEndAction(values: FormData) {
  const item = JSON.parse(str(values, "series"));
  return {
    action: "save-series",
    id: str(values, "seriesId"),
    version: Number(values.get("version")),
    series: {
      firstDate: item.firstDate,
      localTime: item.localTime,
      intervalWeeks: item.intervalWeeks,
      endDate: str(values, "endDate") || null,
      meetingPoint: item.meetingPoint,
      meetingPointUrl: item.meetingPointUrl ?? "",
      spots: item.spots,
      open: Boolean(item.open),
      hidden: Boolean(item.hidden),
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
    if (!reason || !input) continue;
    const update = () => {
      reason.hidden = !eventEmailPrompt(
        new FormData(form),
        form.dataset.emailPrompt,
        form.dataset.futureEmailPrompt,
      );
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
    "[data-event-save]",
  )) {
    if (form.dataset.submitting) continue;
    const recurring =
      form.querySelector<HTMLInputElement>('[name="recurring"]');
    const types = [
      ...form.querySelectorAll<HTMLInputElement>(
        'input[type="radio"][name="type"]',
      ),
    ];
    const controls = form.querySelector<HTMLElement>(
      "[data-recurrence-controls]",
    );
    const fields = form.querySelector<HTMLElement>("[data-recurrence-fields]");
    if (!recurring || !types.length || !controls || !fields) continue;
    const endDate = fields.querySelector<HTMLInputElement>('[name="endDate"]')!;
    const start = form.querySelector<HTMLInputElement>('[name="startsAt"]')!;
    const update = () => {
      const patrol = types.some(
        (type) => type.checked && type.value === "patrol",
      );
      if (!patrol) recurring.checked = false;
      controls.hidden = !patrol;
      recurring.disabled = !patrol;
      fields.hidden = !patrol || !recurring.checked;
      for (const input of fields.querySelectorAll<HTMLInputElement>("input"))
        input.disabled = fields.hidden;
      endDate.min = start.value.slice(0, 10);
    };
    if (!form.dataset.recurrenceReady) {
      form.dataset.recurrenceReady = "true";
      for (const type of types) type.addEventListener("change", update);
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

/** Keep open series drafts, just like individual event editors. */
export function syncSeriesControls(page: Document, element?: HTMLFormElement) {
  const root = document.querySelector<HTMLElement>("[data-series-list]");
  const next = page.querySelector<HTMLElement>("[data-series-list]");
  if (!root || !next) return false;
  let deferred = false;
  for (const updated of next.querySelectorAll<HTMLDetailsElement>(
    "[data-live-series]",
  )) {
    const current = [
      ...root.querySelectorAll<HTMLDetailsElement>("[data-live-series]"),
    ].find((item) => item.dataset.liveSeries === updated.dataset.liveSeries);
    if (current?.dataset.seriesVersion === updated.dataset.seriesVersion)
      continue;
    if (
      current &&
      (current.open || current.querySelector('[data-submitting="true"]')) &&
      !current.contains(element ?? null)
    ) {
      deferred = true;
      continue;
    }
    const replacement = document.importNode(updated, true);
    if (current) {
      replacement.open = current.open;
      current.replaceWith(replacement);
    } else root.appendChild(replacement);
  }
  const empty = root.querySelector("p:not([class])");
  if (root.querySelector("[data-live-series]")) empty?.remove();
  return deferred;
}
