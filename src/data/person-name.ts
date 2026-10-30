export interface PersonName {
  firstName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
}

/** Display only; never change the underlying profile or submitted answers. */
export function personDisplayName(
  answers?: PersonName | null,
  legacyName = "",
  fallback = "",
): string {
  const given =
    answers?.preferredName?.trim() || answers?.firstName?.trim() || "";
  const surname = answers?.lastName?.trim() || "";
  if (given || surname)
    return [given, surname ? `${Array.from(surname)[0]}.` : ""]
      .filter(Boolean)
      .join(" ");

  const parts = legacyName.trim().split(/\s+/u).filter(Boolean);
  if (!parts.length) return fallback;
  return parts.length > 1
    ? `${parts[0]} ${Array.from(parts.at(-1)!)[0]}.`
    : parts[0];
}
