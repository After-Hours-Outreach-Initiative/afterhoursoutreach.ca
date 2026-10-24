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

/** Date-only arithmetic keeps all 35 days intact across Vancouver DST changes. */
export function eventCalendar(
  events: CalendarEvent[],
  start?: string,
  now = Date.now(),
) {
  const today = vancouverInput(now).slice(0, 10);
  const dated = [...events]
    .sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))
    .map((event) => ({
      ...event,
      date: vancouverInput(event.startsAt).slice(0, 10),
      description: `${formatEventDate(event.startsAt)} · ${event.label}`,
    }));
  const firstDate = dated[0]?.date ?? today;
  const lastDate = dated.at(-1)?.date ?? today;
  const first = calendarWeekStart(firstDate < today ? firstDate : today);
  const last = calendarWeekStart(lastDate > today ? lastDate : today);
  const requested = start ? calendarWeekStart(start) : calendarWeekStart(today);
  start = requested < first ? first : requested > last ? last : requested;
  const end = addCalendarDays(start, 34);
  const rangeFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const days = Array.from({ length: 35 }, (_, index) => {
    const date = addCalendarDays(start, index);
    return {
      date,
      day: Number(date.slice(-2)),
      today: date === today,
      events: dated.filter((event) => event.date === date),
    };
  });
  return {
    start,
    range: rangeFormat.formatRange(
      new Date(`${start}T00:00:00Z`),
      new Date(`${end}T00:00:00Z`),
    ),
    previous: start > first ? addCalendarDays(start, -35) : null,
    next: end < last ? addCalendarDays(start, 35) : null,
    weeks: Array.from({ length: 5 }, (_, index) =>
      days.slice(index * 7, index * 7 + 7),
    ),
  };
}
