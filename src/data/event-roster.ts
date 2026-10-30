export type AttendeeCategory = "medic" | "outreach-volunteer" | "new-volunteer";

/** Legacy combined names are abbreviated, never displayed verbatim. */
export function publicAttendeeName(
  firstName: string | null,
  lastName: string | null,
  legacyName: string,
  preferredName: string | null = null,
) {
  if (firstName?.trim() && lastName?.trim())
    return `${preferredName?.trim() || firstName.trim()} ${Array.from(lastName.trim())[0]}.`;
  const parts = legacyName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Outreach Volunteer";
  return parts.length > 1
    ? `${parts[0]} ${Array.from(parts.at(-1)!)[0]}.`
    : `${Array.from(parts[0])[0]}.`;
}
