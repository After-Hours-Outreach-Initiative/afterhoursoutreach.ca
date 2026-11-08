import { signupMoveCalendar } from "../data/signup-move-calendar";
import { vancouverInput } from "../data/event-time";

/** Read the same server-rendered options used by the submitted select. */
export function syncSignupMoveCalendar(dialog: HTMLElement, month?: string) {
  const calendar = dialog.querySelector<HTMLElement>(
    "[data-signup-move-calendar]",
  );
  const select = dialog.querySelector('select[name="destination"]');
  if (!calendar || !(select instanceof HTMLSelectElement)) return;
  const destinations = [...select.options]
    .filter((option) => option.value)
    .map((option) => ({
      id: option.value,
      startsAt: Number(option.dataset.startsAt),
      label: option.dataset.calendarLabel!,
    }));
  const selected = destinations.find((event) => event.id === select.value);
  const model = signupMoveCalendar(
    Number(calendar.dataset.signupCurrentStart),
    destinations,
    month ??
      (selected ? vancouverInput(selected.startsAt).slice(0, 7) : undefined),
  );
  calendar.dataset.signupMonth = model.month;
  calendar.querySelector("[data-signup-month-label]")!.textContent =
    model.label;
  for (const step of ["previous", "next"] as const) {
    const button = calendar.querySelector<HTMLButtonElement>(
      `[data-signup-month-step="${step}"]`,
    )!;
    button.disabled = !model[step];
    button.dataset.signupMonthTarget = model[step] ?? "";
  }
  const days = calendar.querySelector<HTMLElement>("[data-signup-month-days]")!;
  const focused = document.activeElement;
  const focusedId =
    focused instanceof HTMLElement && days.contains(focused)
      ? focused.dataset.signupDestination
      : undefined;
  days.replaceChildren(
    ...model.weeks.map((week) => {
      const row = document.createElement("tr");
      for (const day of week) {
        const cell = document.createElement("td");
        cell.dataset.signupDate = day.date;
        row.appendChild(cell);
        if (!day.inMonth) continue;
        const date = document.createElement("span");
        date.className = "event-calendar-day";
        date.textContent = String(day.day);
        const destinationButton = (event: {
          id: string;
          description: string;
        }) => {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.signupDestination = event.id;
          button.setAttribute("aria-label", event.description);
          button.setAttribute(
            "aria-pressed",
            String(event.id === select.value),
          );
          button.title = event.description;
          return button;
        };
        if (day.current || day.events.length) {
          date.classList.add("event-calendar-circle");
          const button = day.current
            ? document.createElement("button")
            : destinationButton(day.events[0]);
          button.type = "button";
          button.className = "signup-move-date";
          if (day.current) {
            button.dataset.signupCurrent = "";
            button.disabled = true;
            button.setAttribute(
              "aria-label",
              `${day.date} · Current event (not selectable)`,
            );
            button.title = "Current event (not selectable)";
          }
          button.appendChild(date);
          cell.appendChild(button);
        } else cell.appendChild(date);
        const extra = document.createElement("div");
        extra.className = "event-calendar-extra-events";
        for (const event of day.current ? day.events : day.events.slice(1)) {
          const button = destinationButton(event);
          const dot = document.createElement("span");
          dot.className = "event-calendar-dot";
          dot.setAttribute("aria-hidden", "true");
          button.appendChild(dot);
          extra.appendChild(button);
        }
        if (extra.childElementCount) cell.appendChild(extra);
      }
      return row;
    }),
  );
  if (focusedId)
    [...days.querySelectorAll<HTMLButtonElement>("[data-signup-destination]")]
      .find((button) => button.dataset.signupDestination === focusedId)
      ?.focus({ preventScroll: true });
}

export function initSignupMoveCalendars() {
  document.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || select.name !== "destination")
      return;
    const dialog = select.closest<HTMLElement>("dialog");
    if (dialog) syncSignupMoveCalendar(dialog);
  });
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(
      "[data-signup-month-step], [data-signup-destination]",
    );
    if (!button || button.disabled) return;
    const dialog = button.closest<HTMLElement>("dialog")!;
    const select = dialog.querySelector('select[name="destination"]');
    if (!(select instanceof HTMLSelectElement)) return;
    if (button.dataset.signupDestination) {
      select.value = button.dataset.signupDestination;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      syncSignupMoveCalendar(dialog, button.dataset.signupMonthTarget);
    }
  });
}
