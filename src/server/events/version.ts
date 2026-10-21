import { canViewEvents, type Actor } from "../db/access";
import type {
  EventRow,
  RosterRow,
  PatrolSeriesRow,
  PublicRoster,
} from "../db/events";

// Only an opaque view version is returned by polling. The normal page rendering
// still authorizes and supplies event details, signup controls and rosters.
export async function eventViewVersion(
  events: EventRow[],
  actor: Actor | null,
  rosters: RosterRow[] = [],
  now = Date.now(),
  series: PatrolSeriesRow[] = [],
  publicRoster?: PublicRoster,
) {
  const view = JSON.stringify({
    events,
    series: actor?.role === "organizer" && canViewEvents(actor) ? series : [],
    // Crossing the start time changes the controls even if no database row changes.
    started: events.map((event) => event.startsAt <= now),
    // Counts alone miss attendee swaps, renamed volunteers and marked attendance.
    // Privileged data remains organizer-only. The public projection/digest is
    // scoped to the SAME visible event IDs as the normal volunteer page.
    rosters: actor?.role === "organizer" && canViewEvents(actor) ? rosters : [],
    publicRoster: canViewEvents(actor) ? publicRoster : undefined,
    actor: actor && {
      id: actor.id,
      role: actor.role,
      applicationSubmitted: actor.applicationSubmitted,
      active: actor.active,
      applicationApproved: actor.applicationApproved,
      patrolApproved: actor.patrolApproved,
      twoFactorEnabled: actor.twoFactorEnabled,
      twoFactorVerified: actor.twoFactorVerified,
    },
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(view),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
