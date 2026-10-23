import { eventCalendar, type CalendarEvent } from "../data/event-calendar";
import { addCalendarDays } from "../data/event-time";

const highlightTimers = new WeakMap<HTMLElement, number>();
const renderedDays = new WeakMap<HTMLElement, string>();

/** Read the actual cards after filtering/reconciliation, not a second event feed. */
export function syncEventCalendar(root: HTMLElement, start?: string) {
  const calendar = root.querySelector<HTMLElement>("[data-event-calendar]");
  if (!calendar) return;
  const events: CalendarEvent[] = [];
  for (const card of root.querySelectorAll<HTMLElement>(
    "[data-event-list] > [data-live-event]",
  )) {
    if (card.hidden) continue;
    events.push({
      id: card.dataset.liveEvent!,
      startsAt: Number(card.dataset.eventStart),
      label: card.dataset.eventLabel!,
    });
  }
  const model = eventCalendar(events, start ?? calendar.dataset.calendarStart);
  calendar.dataset.calendarStart = model.start;
  calendar.querySelector<HTMLElement>("[data-calendar-controls]")!.hidden =
    false;
  const range = calendar.querySelector<HTMLElement>("[data-calendar-range]")!;
  if (range.textContent?.trim() !== model.range)
    range.textContent = model.range;
  for (const step of ["previous", "next"] as const) {
    calendar.querySelector<HTMLButtonElement>(
      `[data-calendar-step="${step}"]`,
    )!.disabled = !model[step];
  }
  const days = calendar.querySelector<HTMLElement>("[data-calendar-days]")!;
  const signature = JSON.stringify(model.weeks);
  if (renderedDays.get(days) === signature) return;
  renderedDays.set(days, signature);
  const focused = document.activeElement;
  const focusedId =
    focused instanceof HTMLElement && days.contains(focused)
      ? focused.dataset.calendarEvent
      : undefined;
  days.replaceChildren(
    ...model.weeks.map((week) => {
      const row = document.createElement("tr");
      for (const day of week) {
        const cell = document.createElement("td");
        cell.dataset.calendarDate = day.date;
        if (day.today) cell.setAttribute("aria-current", "date");
        const date = document.createElement("span");
        date.className = "event-calendar-day";
        date.textContent = String(day.day);
        if (!day.events.length) cell.appendChild(date);
        const extraEvents = document.createElement("div");
        extraEvents.className = "event-calendar-extra-events";
        for (const [index, event] of day.events.entries()) {
          const link = document.createElement("a");
          link.href = `#event-${event.id}`;
          link.dataset.calendarEvent = event.id;
          link.setAttribute("aria-label", event.description);
          link.title = event.label;
          if (index === 0) {
            date.classList.add("event-calendar-circle");
            link.appendChild(date);
            cell.appendChild(link);
          } else {
            const dot = document.createElement("span");
            dot.className = "event-calendar-dot";
            dot.setAttribute("aria-hidden", "true");
            link.appendChild(dot);
            extraEvents.appendChild(link);
          }
        }
        if (extraEvents.childElementCount) cell.appendChild(extraEvents);
        row.appendChild(cell);
      }
      return row;
    }),
  );
  if (focusedId) {
    const replacement = [
      ...days.querySelectorAll<HTMLElement>("[data-calendar-event]"),
    ].find((link) => link.dataset.calendarEvent === focusedId);
    (
      replacement ??
      calendar.querySelector<HTMLElement>('[data-calendar-step="today"]')
    )?.focus({ preventScroll: true });
  }
}

export function handleEventCalendarClick(root: HTMLElement, event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const step = event.target.closest<HTMLButtonElement>("[data-calendar-step]");
  if (step) {
    const calendar = root.querySelector<HTMLElement>("[data-event-calendar]")!;
    const offset = step.dataset.calendarStep === "previous" ? -35 : 35;
    const start =
      step.dataset.calendarStep === "today"
        ? undefined
        : addCalendarDays(calendar.dataset.calendarStart!, offset);
    // An empty start resets to the current Vancouver week.
    syncEventCalendar(root, start ?? "");
    return;
  }
  const link = event.target.closest<HTMLAnchorElement>("[data-calendar-event]");
  if (
    !link ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const card = [
    ...root.querySelectorAll<HTMLElement>("[data-live-event]"),
  ].find((card) => card.dataset.liveEvent === link.dataset.calendarEvent);
  if (!card || card.hidden) return;
  event.preventDefault();
  // Keep filter/occurrence query parameters and native back/forward navigation.
  history.pushState(null, "", link.hash);
  card.focus({ preventScroll: true });
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({
    behavior: reduced ? "instant" : "smooth",
    block: "start",
  });
  card.removeAttribute("data-calendar-highlight");
  // Restart the short highlight if the same event is selected again.
  void card.offsetWidth;
  card.setAttribute("data-calendar-highlight", "");
  window.clearTimeout(highlightTimers.get(card));
  highlightTimers.set(
    card,
    window.setTimeout(
      () => card.removeAttribute("data-calendar-highlight"),
      1600,
    ),
  );
}
