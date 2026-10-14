import type { Actor } from "../db/access";
import type { EventRow } from "../db/events";

// Only an opaque view version is returned by polling. The normal page rendering
// still authorizes and supplies event details, signup controls and rosters.
export async function eventViewVersion(
  events: EventRow[],
  actor: Actor | null,
) {
  const view = JSON.stringify({
    events,
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
