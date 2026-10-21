import {
  applicationBirthDateError,
  isValidApplicationBirthDate,
} from "../data/application";
import {
  canonicalDate,
  dateDraftValue,
  dateParts,
  type DateParts,
} from "../data/date-input";
import { vancouverInstant } from "../data/event-time";
import { syncNativePickerInput } from "./native-picker-input";

const parts = ["day", "month", "year"] as const;
const initialized = new WeakMap<HTMLFieldSetElement, () => void>();

function controls(group: HTMLFieldSetElement) {
  return {
    canonical: group.querySelector<HTMLInputElement>(
      'input[type="hidden"][name]',
    )!,
    date: group.querySelector<HTMLInputElement>("[data-native-date]"),
    day: group.querySelector<HTMLInputElement>('[data-date-part="day"]')!,
    month: group.querySelector<HTMLInputElement>('[data-date-part="month"]')!,
    year: group.querySelector<HTMLInputElement>('[data-date-part="year"]')!,
    time: group.querySelector<HTMLInputElement>("[data-date-time-input]"),
  };
}

function sync(group: HTMLFieldSetElement) {
  const fields = controls(group);
  const value = fields.date
    ? dateParts(fields.date.value)
    : {
        day: fields.day.value,
        month: fields.month.value,
        year: fields.year.value,
      };
  const date = canonicalDate(value);
  const time = fields.time?.value;
  fields.canonical.value =
    date && (!fields.time || /^\d{2}:\d{2}$/.test(time!))
      ? `${date}${fields.time ? `T${time}` : ""}`
      : "";
  if (fields.date) syncNativePickerInput(fields.date);
  return fields.date ? fields.date.value : dateDraftValue(value);
}

function groups(root: Document | HTMLElement) {
  return root.querySelectorAll<HTMLFieldSetElement>("[data-date-input]");
}

// Draft strings preserve correction buffers; only canonical values enter FormData.
export function readDateInputs(root: Document | HTMLElement) {
  return Object.fromEntries(
    [...groups(root)].map((group) => [group.dataset.dateInput!, sync(group)]),
  );
}

export function restoreDateInputs(
  root: Document | HTMLElement,
  values: Record<string, unknown>,
) {
  for (const group of groups(root)) {
    const value = values[group.dataset.dateInput!];
    if (typeof value !== "string") continue;
    const fields = controls(group);
    const restored = dateParts(value);
    if (fields.date) fields.date.value = canonicalDate(restored);
    else for (const part of parts) fields[part].value = restored[part];
    sync(group);
    initialized.get(group)?.();
  }
}

export function saveDateInputDefaults(
  root: Document | HTMLElement,
  values: Record<string, string>,
) {
  for (const group of groups(root)) {
    const fields = controls(group);
    const saved = dateParts(values[group.dataset.dateInput!] ?? "");
    if (fields.date) {
      const current = fields.date.value;
      fields.date.defaultValue = canonicalDate(saved);
      fields.date.value = current;
      syncNativePickerInput(fields.date);
      continue;
    }
    for (const part of parts) {
      const input = fields[part];
      const current = input.value;
      input.defaultValue = saved[part];
      input.value = current;
    }
  }
}

export function setDateInputActive(
  group: HTMLFieldSetElement,
  active: boolean,
) {
  group.hidden = !active;
  for (const input of group.querySelectorAll<HTMLInputElement>(
    "[data-date-part], [data-native-date]",
  )) {
    input.required = active;
    input.readOnly = !active;
  }
  initialized.get(group)?.();
}

export function initDateInputs(root: Document | HTMLElement) {
  for (const group of groups(root)) {
    const refresh = initialized.get(group);
    if (refresh) {
      // Recheck the clock when an event is saved after sitting open.
      refresh();
      continue;
    }
    const fields = controls(group);
    const feedback = group.querySelector<HTMLElement>("[data-error] span")!;
    const fallback = feedback.textContent!;
    const birthDate = group.hasAttribute("data-birth-date");
    const withTime = group.hasAttribute("data-date-time");
    const warning = group.querySelector<HTMLElement>(
      "[data-date-past-warning]",
    );
    const checkTime = () => {
      const instant = vancouverInstant(fields.canonical.value);
      if (warning) warning.hidden = Date.parse(instant) >= Date.now();
    };
    let showError = false;
    const update = () => {
      sync(group);
      if (warning) warning.hidden = true;
      if (fields.date) {
        const { date, time } = fields;
        for (const input of [date, time]) {
          input?.setCustomValidity("");
          if (withTime) input?.removeAttribute("aria-invalid");
        }
        if (withTime) group.removeAttribute("aria-invalid");
        let error = "";
        if (!date.readOnly && date.value && time) {
          if (!time.value) error = "Enter a start time.";
          else if (date.validity.valid && time.validity.valid) {
            try {
              checkTime();
            } catch (failure) {
              error = (failure as Error).message;
            }
          }
          time.setCustomValidity(error);
          if (withTime && showError && error)
            time.setAttribute("aria-invalid", "true");
        }
        if (withTime && showError && !date.validity.valid)
          date.setAttribute("aria-invalid", "true");
        feedback.textContent = error || fallback;
        return;
      }
      const { day, month, year, time } = fields;
      for (const input of [day, month, year, time]) {
        input?.setCustomValidity("");
        if (withTime) input?.removeAttribute("aria-invalid");
      }
      if (day.readOnly) return;
      if (
        !day.required &&
        !day.value &&
        !month.value &&
        !year.value &&
        !time?.value
      )
        return;
      let error: [keyof DateParts | "time", string] | undefined;
      if (!day.value)
        error = [
          "day",
          birthDate ? "Enter your day of birth." : "Enter the day.",
        ];
      else if (
        !/^\d{1,2}$/.test(day.value) ||
        +day.value < 1 ||
        +day.value > 31
      )
        error = ["day", "Enter a day from 1 to 31."];
      else if (!month.value)
        error = [
          "month",
          birthDate ? "Enter your month of birth." : "Enter the month.",
        ];
      else if (
        !/^\d{1,2}$/.test(month.value) ||
        +month.value < 1 ||
        +month.value > 12
      )
        error = ["month", "Enter a month from 1 to 12."];
      else if (!year.value)
        error = [
          "year",
          birthDate ? "Enter your year of birth." : "Enter the year.",
        ];
      else if (!/^\d{4}$/.test(year.value) || (birthDate && +year.value < 1900))
        error = [
          "year",
          birthDate
            ? "Enter a four-digit year of 1900 or later."
            : "Enter a four-digit year.",
        ];
      else if (
        !canonicalDate({ day: day.value, month: month.value, year: year.value })
      )
        error = [
          "day",
          birthDate
            ? "Enter a real date of birth. Check the day and month."
            : "Enter a real date. Check the day and month.",
        ];
      else if (
        birthDate &&
        !isValidApplicationBirthDate(fields.canonical.value)
      )
        error = ["year", applicationBirthDateError];
      else if (time) {
        if (!time.value) error = ["time", "Enter a start time."];
        else {
          try {
            checkTime();
          } catch (failure) {
            error = ["time", (failure as Error).message];
          }
        }
      }
      if (error) {
        const input = fields[error[0]]!;
        input.setCustomValidity(error[1]);
        if (withTime && showError) input.setAttribute("aria-invalid", "true");
      }
      feedback.textContent = error?.[1] ?? fallback;
    };
    initialized.set(group, update);
    // Target listeners run before form-level autosave and dirty tracking.
    group.addEventListener("input", update);
    group.addEventListener("change", update);
    if (withTime) {
      // A calendar error can belong to an untouched part (e.g. day 31 after
      // changing the month). Expose it on the visible control, not the hidden
      // canonical value, without relying solely on :user-invalid.
      group.addEventListener("focusout", (event) => {
        if (
          event.relatedTarget instanceof Node &&
          group.contains(event.relatedTarget)
        )
          return;
        showError = true;
        update();
      });
      group.addEventListener(
        "invalid",
        () => {
          showError = true;
          update();
        },
        true,
      );
    }
    group.form?.addEventListener("reset", () => {
      showError = false;
      queueMicrotask(update);
    });
    update();
  }
}
