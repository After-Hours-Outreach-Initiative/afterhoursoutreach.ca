import { calendarWeekStart, type CalendarEvent } from "./event-calendar";
import { addCalendarDays, formatEventDate, vancouverInput } from "./event-time";

/** Month arithmetic is date-only so Vancouver DST cannot shift a calendar day. */
export function signupMoveCalendar(
  currentStart: number,
  destinations: CalendarEvent[],
  month = vancouverInput(currentStart).slice(0, 7),
) {
  const currentDate = vancouverInput(currentStart).slice(0, 10);
  const dated = [...destinations]
    .sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))
    .map((event) => ({
      ...event,
      date: vancouverInput(event.startsAt).slice(0, 10),
      description: `${formatEventDate(event.startsAt)} · ${event.label}`,
    }));
  const months = [
    currentDate.slice(0, 7),
    ...dated.map((e) => e.date.slice(0, 7)),
  ].sort();
  month =
    month < months[0]
      ? months[0]
      : month > months.at(-1)!
        ? months.at(-1)!
        : month;
  const first = `${month}-01`;
  const next = new Date(`${first}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const nextMonth = next.toISOString().slice(0, 7);
  const previous = new Date(`${first}T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const start = calendarWeekStart(first);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = addCalendarDays(start, index);
    return {
      date,
      day: Number(date.slice(-2)),
      inMonth: date.slice(0, 7) === month,
      current: date === currentDate,
      events: dated.filter((event) => event.date === date),
    };
  });
  return {
    month,
    label: new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    }).format(new Date(`${first}T00:00:00Z`)),
    previous: month > months[0] ? previous.toISOString().slice(0, 7) : null,
    next: month < months.at(-1)! ? nextMonth : null,
    weeks: Array.from({ length: 6 }, (_, index) =>
      days.slice(index * 7, index * 7 + 7),
    ).filter((week) => week.some((day) => day.inMonth)),
  };
}
