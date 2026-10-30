import { eventCalendar, type CalendarEvent } from "../data/event-calendar";
import { addCalendarDays } from "../data/event-time";

const selections = new WeakMap<
  HTMLElement,
  { card: HTMLElement; cancel: () => void }
>();
const renderedDays = new WeakMap<HTMLElement, string>();

function clearSelection(root: HTMLElement) {
  selections.get(root)?.cancel();
}

/** Let the selected event settle below the header before starting its highlight. */
function highlightEvent(root: HTMLElement, card: HTMLElement) {
  clearSelection(root);
  const controller = new AbortController();
  let frame = 0;
  let timer: number | undefined;
  const cancel = () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    controller.abort();
    card.removeAttribute("data-calendar-highlight");
    selections.delete(root);
  };
  selections.set(root, { card, cancel });
  // Manual navigation or a new selection must not leave a delayed highlight.
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"])
    window.addEventListener(
      type,
      () => {
        if (frame) cancel();
      },
      { passive: true, capture: true, signal: controller.signal },
    );

  const deadline = performance.now() + 3000;
  let previousTop: number | undefined;
  let settledFrames = 0;
  const waitForEvent = () => {
    if (!root.contains(card) || card.hidden || performance.now() > deadline) {
      cancel();
      return;
    }
    const bounds = card.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".site-header");
    const readingEdge = Math.max(
      0,
      header?.getBoundingClientRect().bottom ?? 0,
    );
    const visible =
      bounds.top >= readingEdge - 1 &&
      Math.min(bounds.bottom, innerHeight) - bounds.top >=
        Math.min(bounds.height, innerHeight - readingEdge, 64) - 1;
    settledFrames =
      previousTop !== undefined && Math.abs(bounds.top - previousTop) < 0.5
        ? settledFrames + 1
        : 0;
    previousTop = bounds.top;
    if (visible && settledFrames >= 2) {
      frame = 0;
      card.setAttribute("data-calendar-highlight", "");
      timer = window.setTimeout(cancel, 1600);
    } else frame = requestAnimationFrame(waitForEvent);
  };
  frame = requestAnimationFrame(waitForEvent);
}

/** Read the actual cards after filtering/reconciliation, not a second event feed. */
export function syncEventCalendar(root: HTMLElement, start?: string) {
  const calendar = root.querySelector<HTMLElement>("[data-event-calendar]");
  if (!calendar) return;
  const selected = selections.get(root)?.card;
  if (
    selected &&
    (selected.hidden ||
      !root.contains(selected) ||
      location.hash !== `#${selected.id}`)
  )
    clearSelection(root);
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
        const event = day.events[0];
        if (event) {
          const link = document.createElement("a");
          link.href = `#event-${event.id}`;
          link.dataset.calendarEvent = event.id;
          link.setAttribute("aria-label", event.description);
          link.title = event.label;
          date.classList.add("event-calendar-circle");
          link.appendChild(date);
          cell.appendChild(link);
        } else cell.appendChild(date);
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
  if (event.target.closest("[data-event-filter]")) clearSelection(root);
  const step = event.target.closest<HTMLButtonElement>("[data-calendar-step]");
  if (step) {
    if (step.disabled) return;
    clearSelection(root);
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
  if (location.hash !== link.hash) history.pushState(null, "", link.hash);
  card.focus({ preventScroll: true });
  highlightEvent(root, card);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({
    behavior: reduced ? "instant" : "smooth",
    block: "start",
  });
}
