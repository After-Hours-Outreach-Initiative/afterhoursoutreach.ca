import { personDisplayName } from "./person-name";

export type AttendeeCategory = "medic" | "outreach-volunteer" | "new-volunteer";

/** Shared display policy for public and organizer rosters. */
export function publicAttendeeName(
  firstName: string | null,
  lastName: string | null,
  legacyName: string,
  preferredName: string | null = null,
) {
  return personDisplayName(
    { firstName, lastName, preferredName },
    legacyName,
    "Outreach Volunteer",
  );
}
