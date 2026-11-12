import { defaultEventLimits, minimumEventSpots } from "../data/event-limits";
import { defaultUnregisterMinutes } from "../data/event-unregistration";

const str = (values: FormData, key: string) => String(values.get(key) ?? "");

export function eventFields(values: FormData) {
  return {
    meetingPoint: str(values, "meetingPoint"),
    meetingPointUrl: str(values, "meetingPointUrl"),
    spots: Number(values.get("spots")),
    minMedicSpots: Number(
      values.get("minMedicSpots") ?? defaultEventLimits.minMedicSpots,
    ),
    minNewVolunteerSpots: Number(
      values.get("minNewVolunteerSpots") ??
        defaultEventLimits.minNewVolunteerSpots,
    ),
    maxNewVolunteers: Number(
      values.get("maxNewVolunteers") ?? defaultEventLimits.maxNewVolunteers,
    ),
    unregisterMinutes: Number(
      values.get("unregisterMinutes") ?? defaultUnregisterMinutes,
    ),
    includesOrientation: str(values, "includesOrientation") === "true",
    open: str(values, "publicVisibility") === "true",
    hidden: str(values, "publicVisibility") !== "true",
  };
}

const seriesScope = (values: FormData) => {
  const scope = str(values, "scope");
  return values.has("seriesId") && (scope === "future" || scope === "all")
    ? scope
    : null;
};

function seriesTemplate(values: FormData) {
  const start = str(values, "startsAt");
  const dayOffset =
    (Date.parse(`${start.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${str(values, "occurrenceDate")}T00:00:00Z`)) /
    86_400_000;
  return {
    ...eventFields(values),
    localTime: start.slice(11, 16),
    dayOffset,
    ...(values.has("intervalWeeks")
      ? {
          intervalWeeks: Number(values.get("intervalWeeks")),
          endDate: str(values, "endDate") || null,
        }
      : {}),
  };
}

/** True when the repeat interval or last date differs from the saved form. */
export function seriesScheduleChanged(values: FormData, saved?: FormData) {
  return Boolean(
    saved &&
    ["intervalWeeks", "endDate"].some(
      (key) => values.has(key) && str(values, key) !== str(saved, key),
    ),
  );
}

/** Series edits send only the fields changed since the form was loaded, so a
 * date's own edits never spread to the other dates. */
export function recurringSaveAction(values: FormData, saved?: FormData) {
  const scope = seriesScope(values);
  if (scope) {
    const template = seriesTemplate(values);
    const before: Record<string, unknown> = saved ? seriesTemplate(saved) : {};
    return {
      action: "update-series-from",
      id: str(values, "seriesId"),
      version: Number(values.get("seriesVersion")),
      occurrenceDate: str(values, "occurrenceDate"),
      scope,
      template: Object.fromEntries(
        Object.entries(template).filter(
          ([key, value]) =>
            !saved || JSON.stringify(value) !== JSON.stringify(before[key]),
        ),
      ),
    };
  }
  const start = str(values, "startsAt");
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
  const scope = seriesScope(values);
  return scope
    ? {
        action: "stop-series",
        id: str(values, "seriesId"),
        version: Number(values.get("seriesVersion")),
        occurrenceDate: str(values, "occurrenceDate"),
        scope,
        reason: str(values, "reason"),
      }
    : null;
}

export function eventEmailPrompt(
  values: FormData,
  occurrencePrompt?: string,
  futurePrompt?: string,
  allPrompt?: string,
) {
  const scope = seriesScope(values);
  return scope === "all"
    ? allPrompt
    : scope === "future"
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
        form.dataset.allEmailPrompt,
      );
      input.disabled = reason.hidden;
    };
    if (!form.dataset.cancelReasonReady) {
      form.dataset.cancelReasonReady = "true";
      for (const scope of form.querySelectorAll('[name="scope"]'))
        scope.addEventListener("change", update);
      form.addEventListener("reset", () => queueMicrotask(update));
    }
    update();
  }
  for (const form of root.querySelectorAll<HTMLFormElement>(
    "[data-event-save]",
  )) {
    if (form.dataset.submitting) continue;
    const orientation = form.querySelector<HTMLInputElement>(
      '[name="includesOrientation"][value="true"]',
    );
    const spots = form.querySelector<HTMLInputElement>('[name="spots"]');
    const capacityFeedback = form.querySelector<HTMLElement>(
      '[data-error$="-spots"] span',
    );
    const minMedicSpots = form.querySelector<HTMLInputElement>(
      '[name="minMedicSpots"]',
    );
    const minNewVolunteerSpots = form.querySelector<HTMLInputElement>(
      '[name="minNewVolunteerSpots"]',
    );
    const maxNewVolunteers = form.querySelector<HTMLInputElement>(
      '[name="maxNewVolunteers"]',
    );
    if (orientation && spots && capacityFeedback) {
      const updateCapacity = () => {
        const minimum = minimumEventSpots({
          includesOrientation: orientation.checked,
          minMedicSpots: Number(
            minMedicSpots?.value ?? defaultEventLimits.minMedicSpots,
          ),
          minNewVolunteerSpots: Number(
            minNewVolunteerSpots?.value ??
              defaultEventLimits.minNewVolunteerSpots,
          ),
        });
        spots.min = String(minimum);
        capacityFeedback.textContent =
          minimum > 100
            ? "Reduce reserved places to a combined maximum of 100."
            : `Enter a whole number from ${minimum} to 100, covering all reserved places.`;
        if (maxNewVolunteers && minNewVolunteerSpots)
          maxNewVolunteers.min = minNewVolunteerSpots.value || "0";
      };
      if (!form.dataset.capacityReady) {
        form.dataset.capacityReady = "true";
        for (const input of form.querySelectorAll(
          '[name="includesOrientation"]',
        ))
          input.addEventListener("change", updateCapacity);
        for (const input of [minMedicSpots, minNewVolunteerSpots])
          input?.addEventListener("input", updateCapacity);
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
