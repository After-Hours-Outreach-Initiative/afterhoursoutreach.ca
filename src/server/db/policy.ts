// User-facing previews of the rules enforced by database writes and triggers.sql.
export interface SignupVolunteer {
  applicationSubmitted: boolean;
  active: boolean;
  applicationApproved: boolean;
  patrolApproved: boolean;
  role?: "volunteer" | "organizer";
}

export interface SignupEvent {
  type: "patrol" | "orientation";
  startsAt: Date;
  open: boolean;
  spots: number;
  orientationSignupBlocked?: boolean;
}

export const orientationSignupLimitMessage =
  "You can book one upcoming orientation at a time until your first orientation is marked completed. Unregister from your current orientation before choosing another.";

/** UI feedback only; database triggers enforce eligibility and limits atomically. */
export function signupBlockReason(
  volunteer: SignupVolunteer | null,
  event: SignupEvent,
  confirmed: number,
  now = new Date(),
): string | null {
  if (!volunteer) return "Sign in to register.";
  if (!volunteer.applicationSubmitted)
    return "Complete your volunteer application before registering for events.";
  if (!volunteer.active) return "Your volunteer account is inactive.";
  if (!volunteer.applicationApproved && volunteer.role !== "organizer")
    return "Your application is awaiting organizer approval.";
  if (!event.open) return "This event is closed.";
  if (!Number.isFinite(event.startsAt.getTime()) || event.startsAt <= now)
    return "Registration closes when the event starts.";
  if (event.type === "patrol" && !volunteer.patrolApproved)
    return "Organizer approval is required to register for patrols.";
  if (confirmed >= event.spots) return "This event is full.";
  if (event.type === "orientation" && event.orientationSignupBlocked)
    return orientationSignupLimitMessage;
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
  // Sign-in, event, certification, and submission mail share a budget below 100/day.
  dailyLimit: 80,
  budgetWindowMs: 24 * 60 * 60 * 1000,
  timeoutMs: 10 * 1000,
};
