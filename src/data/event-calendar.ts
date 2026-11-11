import { addCalendarDays, formatEventDate, vancouverInput } from "./event-time";

export interface CalendarEvent {
  id: string;
  startsAt: number;
  label: string;
}

export function calendarWeekStart(date: string) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addCalendarDays(date, -weekday);
}

/** Normalize to the first of a month before shifting, so month lengths cannot overflow. */
export function calendarMonthStart(date: string, offset = 0) {
  const first = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + offset);
  return first.toISOString().slice(0, 10);
}

/** Date-only arithmetic keeps month boundaries intact across Vancouver DST changes. */
export function eventCalendar(
  events: CalendarEvent[],
  start?: string,
  now = Date.now(),
) {
  const today = vancouverInput(now).slice(0, 10);
  const dated = [...events]
    .sort((a, b) => a.startsAt - b.startsAt)
    .map((event) => ({
      ...event,
      date: vancouverInput(event.startsAt).slice(0, 10),
      description: `${formatEventDate(event.startsAt)} · ${event.label}`,
    }));
  const firstDate = dated[0]?.date ?? today;
  const lastDate = dated.at(-1)?.date ?? today;
  const first = calendarMonthStart(firstDate < today ? firstDate : today);
  const last = calendarMonthStart(lastDate > today ? lastDate : today);
  const requested = calendarMonthStart(start || today);
  start = requested < first ? first : requested > last ? last : requested;
  const month = start.slice(0, 7);
  const gridStart = calendarWeekStart(start);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = addCalendarDays(gridStart, index);
    const inMonth = date.slice(0, 7) === month;
    return {
      date,
      day: Number(date.slice(-2)),
      inMonth,
      today: inMonth && date === today,
      events: dated.filter((event) => event.date === date),
    };
  });
  return {
    start,
    range: new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      month: "short",
      year: "numeric",
    }).format(new Date(`${start}T00:00:00Z`)),
    previous: start > first ? calendarMonthStart(start, -1) : null,
    next: start < last ? calendarMonthStart(start, 1) : null,
    weeks: Array.from({ length: 6 }, (_, index) =>
      days.slice(index * 7, index * 7 + 7),
    ).filter((week) => week.some((day) => day.inMonth)),
  };
}
