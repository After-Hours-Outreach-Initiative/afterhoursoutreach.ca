// User-facing previews of the rules enforced by database writes and triggers.sql.
export interface SignupVolunteer {
  registered: boolean;
  active: boolean;
  patrolApproved: boolean;
}

export interface SignupEvent {
  type: "patrol" | "orientation";
  startsAt: Date;
  open: boolean;
  spots: number;
}

/** UI feedback only; database writes must also enforce capacity atomically. */
export function signupBlockReason(
  volunteer: SignupVolunteer | null,
  event: SignupEvent,
  confirmed: number,
  now = new Date(),
): string | null {
  if (!volunteer) return "Sign in to register.";
  if (!volunteer.registered)
    return "Complete volunteer registration before registering for events.";
  if (!volunteer.active) return "Your volunteer account is inactive.";
  if (!event.open) return "This event is closed.";
  if (!Number.isFinite(event.startsAt.getTime()) || event.startsAt <= now)
    return "Registration closes when the event starts.";
  if (event.type === "patrol" && !volunteer.patrolApproved)
    return "Organizer approval is required to register for patrols.";
  if (confirmed >= event.spots) return "This event is full.";
  return null;
}

/** Call only with a server-verified session, never values supplied by a form. */
export function canViewVolunteerProfile(actor: {
  role: "volunteer" | "organizer";
  twoFactorEnabled: boolean;
  twoFactorVerified: boolean;
}): boolean {
  return (
    actor.role === "organizer" &&
    (!actor.twoFactorEnabled || actor.twoFactorVerified)
  );
}

export const emailPolicy = {
  // Sign-in and event mail share a budget below the provider's 100/day quota.
  dailyLimit: 80,
  budgetWindowMs: 24 * 60 * 60 * 1000,
  timeoutMs: 10 * 1000,
};
