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
    throw new Error("Choose a valid Vancouver date and time.");
  const naive = Date.parse(`${input}:00Z`);
  // Vancouver uses UTC−8/−7. Reject skipped or ambiguous DST wall times.
  const candidates = [7, 8]
    .map((offset) => naive + offset * 3_600_000)
    .filter(
      (value) => Number.isFinite(value) && vancouverInput(value) === input,
    );
  if (candidates.length !== 1)
    throw new Error(
      "That Vancouver time is skipped or ambiguous at a daylight-saving change. Choose another time.",
    );
  return new Date(candidates[0]).toISOString();
}
