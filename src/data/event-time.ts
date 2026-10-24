export function formatEventDate(instant: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(instant));
}

/** Display and accept explicit AM/PM, independent of the browser's clock locale. */
export function formatTimeInput(time: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return "";
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 || 12}:${time.slice(3)} ${hour < 12 ? "AM" : "PM"}`;
}

export function parseTimeInput(value: string) {
  const match = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*([ap])m$/i.exec(value.trim());
  if (!match) return "";
  const hour =
    (Number(match[1]) % 12) + (match[3].toLowerCase() === "p" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

/** Calendar inputs always mean America/Vancouver, never the device time zone. */
export function vancouverInput(instant: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

export function vancouverInstant(input: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input))
    throw new Error("Choose a valid date and time.");
  const naive = Date.parse(`${input}:00Z`);
  // Vancouver uses UTC−8/−7. Reject skipped or ambiguous DST wall times.
  const candidates = [7, 8]
    .map((offset) => naive + offset * 3_600_000)
    .filter(
      (value) => Number.isFinite(value) && vancouverInput(value) === input,
    );
  if (candidates.length !== 1)
    throw new Error(
      "That time is skipped or ambiguous at a daylight-saving change. Choose another time.",
    );
  return new Date(candidates[0]).toISOString();
}

/** Add calendar days, not elapsed 24-hour periods in the Vancouver time zone. */
export function addCalendarDays(date: string, days: number) {
  const instant = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(instant).toISOString().slice(0, 10);
}

/**
 * Recurrences keep their local wall time. At a DST fold choose the earlier
 * instant; at a gap move forward by the gap (Temporal's "compatible" policy).
 * Unlike an interactive input, a future occurrence must not break generation.
 */
export function vancouverOccurrenceInstant(date: string, time: string) {
  const input = `${date}T${time}`;
  const naive = Date.parse(`${input}:00Z`);
  if (!Number.isFinite(naive)) throw new Error("Invalid recurrence date.");
  const candidates = [7, 8].map((offset) => naive + offset * 3_600_000);
  const matches = candidates.filter((value) => vancouverInput(value) === input);
  if (matches.length) return Math.min(...matches);
  // Only the spring-forward gap may be normalized. Invalid calendar dates fail.
  const shifted = candidates.find(
    (value) => vancouverInput(value) === `${date}T03:${time.slice(3)}`,
  );
  if (time.startsWith("02:") && shifted !== undefined) return shifted;
  throw new Error("Invalid recurrence date or local time.");
}
