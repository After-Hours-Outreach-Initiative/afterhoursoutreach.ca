import { updateLocalUrl } from "./local-history";
import { eventCalendar, type CalendarEvent } from "../data/event-calendar";

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

/** Read the actual cards after reconciliation, not a second event feed. */
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
      cancelled: card.dataset.eventCancelled !== undefined,
    });
  }
  const model = eventCalendar(events, start ?? calendar.dataset.calendarStart);
  calendar.dataset.calendarStart = model.start;
  for (const control of calendar.querySelectorAll<HTMLElement>(
    "[data-calendar-controls]",
  ))
    control.hidden = !model.previous && !model.next;
  const range = calendar.querySelector<HTMLElement>("[data-calendar-range]")!;
  if (range.textContent?.trim() !== model.range)
    range.textContent = model.range;
  for (const step of ["previous", "next"] as const) {
    const button = calendar.querySelector<HTMLButtonElement>(
      `[data-calendar-step="${step}"]`,
    )!;
    button.disabled = !model[step];
    button.dataset.calendarTarget = model[step] ?? "";
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
        row.appendChild(cell);
        if (!day.inMonth) cell.dataset.calendarOverflow = "";
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
          if (day.cancelled) date.classList.add("event-calendar-cancelled");
          link.appendChild(date);
          cell.appendChild(link);
        } else cell.appendChild(date);
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
      calendar.querySelector<HTMLElement>(
        "[data-calendar-step]:not(:disabled):not([hidden])",
      ) ??
      range
    )?.focus({ preventScroll: true });
  }
}

const monthTransitions = new WeakMap<HTMLElement, () => void>();

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Slide the current month out toward `direction`, then the target month in from the other side. */
function changeMonth(
  root: HTMLElement,
  calendar: HTMLElement,
  step: "previous" | "next",
  offset = 0,
) {
  monthTransitions.get(calendar)?.();
  const target = calendar.querySelector<HTMLButtonElement>(
    `[data-calendar-step="${step}"]`,
  );
  if (!target || target.disabled || !target.dataset.calendarTarget) return;
  const month = target.dataset.calendarTarget;
  clearSelection(root);
  const days = calendar.querySelector<HTMLElement>("[data-calendar-days]")!;
  days.style.removeProperty("transform");
  days.style.removeProperty("opacity");
  if (reducedMotion()) {
    syncEventCalendar(root, month);
    return;
  }
  const direction = step === "next" ? -1 : 1;
  const distance = days.getBoundingClientRect().width * 0.4;
  let rendered = false;
  let incoming: Animation | undefined;
  const outgoing = days.animate(
    [
      {
        transform: `translateX(${offset}px)`,
        opacity: Math.max(0, 1 - Math.abs(offset) / distance / 2.5),
      },
      { transform: `translateX(${direction * distance}px)`, opacity: 0 },
    ],
    { duration: 130, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
  );
  const render = () => {
    if (rendered) return;
    rendered = true;
    syncEventCalendar(root, month);
    outgoing.cancel();
  };
  const finish = () => {
    render();
    incoming?.cancel();
    if (monthTransitions.get(calendar) === finish)
      monthTransitions.delete(calendar);
  };
  monthTransitions.set(calendar, finish);
  outgoing.finished.then(
    () => {
      if (monthTransitions.get(calendar) !== finish) return;
      render();
      incoming = days.animate(
        [
          { transform: `translateX(${-direction * distance}px)`, opacity: 0 },
          { transform: "translateX(0)", opacity: 1 },
        ],
        { duration: 200, easing: "cubic-bezier(0, 0, 0.2, 1)" },
      );
      incoming.finished.then(finish, () => {});
    },
    () => {},
  );
}

/** Follow horizontal touch drags on the month grid; vertical drags keep scrolling the page. */
export function initEventCalendarSwipe(root: HTMLElement) {
  root.addEventListener("pointerdown", (start) => {
    if (start.pointerType === "mouse" || !start.isPrimary) return;
    if (!(start.target instanceof Element)) return;
    const calendar = start.target.closest<HTMLElement>("[data-event-calendar]");
    if (!calendar || !start.target.closest("table")) return;
    const days = calendar.querySelector<HTMLElement>("[data-calendar-days]")!;
    const controller = new AbortController();
    let dragging = false;
    let dx = 0;
    const available = (step: "previous" | "next") =>
      !calendar.querySelector<HTMLButtonElement>(
        `[data-calendar-step="${step}"]`,
      )?.disabled;
    const end = (cancelled: boolean) => {
      controller.abort();
      if (!dragging) return;
      // A completed drag must not also follow the date link under the finger.
      const swallow = (click: Event) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(
        () => window.removeEventListener("click", swallow, true),
        400,
      );
      const step = dx < 0 ? "next" : "previous";
      const threshold = Math.min(64, days.getBoundingClientRect().width * 0.2);
      if (!cancelled && Math.abs(dx) >= threshold && available(step)) {
        changeMonth(root, calendar, step, dx);
        return;
      }
      days.style.removeProperty("transform");
      days.style.removeProperty("opacity");
      if (!reducedMotion() && dx)
        days.animate(
          [
            { transform: `translateX(${dx}px)` },
            { transform: "translateX(0)" },
          ],
          { duration: 180, easing: "cubic-bezier(0, 0, 0.2, 1)" },
        );
    };
    window.addEventListener(
      "pointermove",
      (move) => {
        if (move.pointerId !== start.pointerId) return;
        const x = move.clientX - start.clientX;
        const y = move.clientY - start.clientY;
        if (!dragging) {
          if (Math.abs(x) < 8 || Math.abs(x) <= Math.abs(y)) return;
          dragging = true;
          monthTransitions.get(calendar)?.();
        }
        // Resist past the first or last month that has events.
        dx = available(x < 0 ? "next" : "previous") ? x : x / 4;
        days.style.transform = `translateX(${dx}px)`;
        days.style.opacity = String(
          Math.max(0.4, 1 - Math.abs(dx) / days.getBoundingClientRect().width),
        );
      },
      { signal: controller.signal },
    );
    window.addEventListener(
      "pointerup",
      (up) => up.pointerId === start.pointerId && end(false),
      { signal: controller.signal },
    );
    window.addEventListener(
      "pointercancel",
      (cancel) => cancel.pointerId === start.pointerId && end(true),
      { signal: controller.signal },
    );
  });
}

export function handleEventCalendarClick(root: HTMLElement, event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const step = event.target.closest<HTMLButtonElement>("[data-calendar-step]");
  if (step) {
    const calendar = step.closest<HTMLElement>("[data-event-calendar]");
    if (calendar)
      changeMonth(
        root,
        calendar,
        step.dataset.calendarStep === "next" ? "next" : "previous",
      );
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
  // Keep occurrence query parameters and native back/forward navigation.
  if (location.hash !== link.hash) updateLocalUrl(link.hash, "push");
  card.focus({ preventScroll: true });
  highlightEvent(root, card);
  card.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "center",
    inline: "nearest",
  });
}
