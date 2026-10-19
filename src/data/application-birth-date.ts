export type BirthDateParts = { day: string; month: string; year: string };

export function birthDateParts(value: string): BirthDateParts {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return { day: iso[3], month: iso[2], year: iso[1] };
  try {
    const parts: unknown = JSON.parse(value);
    if (
      Array.isArray(parts) &&
      parts.length === 3 &&
      parts.every((part) => typeof part === "string")
    )
      return { day: parts[0], month: parts[1], year: parts[2] };
  } catch {
    // Old drafts may contain unfinished text from the former single input.
  }
  return { day: "", month: "", year: value };
}

export function canonicalBirthDate({ day, month, year }: BirthDateParts) {
  return /^\d{1,2}$/.test(day) &&
    /^\d{1,2}$/.test(month) &&
    /^\d{4}$/.test(year)
    ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
    : "";
}

export function birthDateDraftValue(parts: BirthDateParts) {
  const { day, month, year } = parts;
  if (!day && !month && !year) return "";
  const iso = canonicalBirthDate(parts);
  // Keep existing ISO drafts compatible; otherwise preserve every unfinished
  // part (including correction buffers) reversibly in the same draft string.
  return iso && day.length === 2 && month.length === 2
    ? iso
    : JSON.stringify([day, month, year]);
}
