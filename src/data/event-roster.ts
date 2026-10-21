export type AttendeeCategory = "medic" | "volunteer" | "orientee";

/** Legacy combined names are abbreviated, never displayed verbatim. */
export function publicAttendeeName(
  firstName: string | null,
  lastName: string | null,
  legacyName: string,
) {
  if (firstName?.trim() && lastName?.trim())
    return `${firstName.trim()} ${Array.from(lastName.trim())[0]}.`;
  const parts = legacyName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Volunteer";
  return parts.length > 1
    ? `${parts[0]} ${Array.from(parts.at(-1)!)[0]}.`
    : `${Array.from(parts[0])[0]}.`;
}
