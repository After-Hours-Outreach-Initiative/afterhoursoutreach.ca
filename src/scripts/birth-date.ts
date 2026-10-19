import {
  applicationBirthDateError,
  isValidApplicationBirthDate,
} from "../data/application";
import {
  birthDateDraftValue,
  birthDateParts,
  canonicalBirthDate,
  type BirthDateParts,
} from "../data/application-birth-date";

function controls(element: HTMLFormElement) {
  const group = element.querySelector<HTMLFieldSetElement>("[data-birth-date]");
  if (!group) return;
  return {
    group,
    canonical: group.querySelector<HTMLInputElement>('[name="birthDate"]')!,
    day: group.querySelector<HTMLInputElement>('[data-birth-date-part="day"]')!,
    month: group.querySelector<HTMLInputElement>(
      '[data-birth-date-part="month"]',
    )!,
    year: group.querySelector<HTMLInputElement>(
      '[data-birth-date-part="year"]',
    )!,
  };
}

export function syncBirthDate(element: HTMLFormElement) {
  const fields = controls(element);
  if (!fields) return;
  const parts = {
    day: fields.day.value,
    month: fields.month.value,
    year: fields.year.value,
  };
  fields.canonical.value = canonicalBirthDate(parts);
  return birthDateDraftValue(parts);
}

export function restoreBirthDate(element: HTMLFormElement, value: string) {
  const fields = controls(element);
  if (!fields) return;
  const parts = birthDateParts(value);
  for (const part of ["day", "month", "year"] as const)
    fields[part].value = parts[part];
  syncBirthDate(element);
}

export function initBirthDate(element: HTMLFormElement) {
  const fields = controls(element);
  if (!fields) return;
  const feedback =
    fields.group.querySelector<HTMLElement>("[data-error] span")!;
  const update = () => {
    syncBirthDate(element);
    const { day, month, year } = fields;
    for (const input of [day, month, year]) input.setCustomValidity("");
    let error: [keyof BirthDateParts, string] | undefined;
    if (!day.value) error = ["day", "Enter your day of birth."];
    else if (!/^\d{1,2}$/.test(day.value) || +day.value < 1 || +day.value > 31)
      error = ["day", "Enter a day from 1 to 31."];
    else if (!month.value) error = ["month", "Enter your month of birth."];
    else if (
      !/^\d{1,2}$/.test(month.value) ||
      +month.value < 1 ||
      +month.value > 12
    )
      error = ["month", "Enter a month from 1 to 12."];
    else if (!year.value) error = ["year", "Enter your year of birth."];
    else if (!/^\d{4}$/.test(year.value) || +year.value < 1900)
      error = ["year", "Enter a four-digit year of 1900 or later."];
    else if (!isValidApplicationBirthDate(fields.canonical.value)) {
      const date = new Date(`${fields.canonical.value}T00:00:00Z`);
      error =
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== fields.canonical.value
          ? ["day", "Enter a real date of birth. Check the day and month."]
          : ["year", applicationBirthDateError];
    }
    if (error) fields[error[0]].setCustomValidity(error[1]);
    feedback.textContent = error?.[1] ?? "Enter your date of birth.";
  };
  // Target-level handling precedes form-level draft/progress listeners, even
  // though draft restoration is initialized first. Never move focus on input.
  fields.group.addEventListener("input", update);
  fields.group.addEventListener("change", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}
