// User-facing previews of the rules enforced by database writes and triggers.sql.
export interface SignupVolunteer {
  applicationSubmitted: boolean;
  active: boolean;
  applicationApproved: boolean;
  patrolApproved: boolean;
  role?: "volunteer" | "organizer";
}

export interface SignupEvent {
  // Legacy callers can keep supplying type; new forms use includesOrientation.
  type?: "patrol" | "orientation";
  includesOrientation?: boolean | number;
  startsAt: Date;
  open: boolean;
  spots: number;
  orientationConfirmed?: number;
  // Whether the current volunteer has ANY recorded orientation completion.
  orientationCompleted?: boolean | number;
  orientationSignupBlocked?: boolean;
}

export const orientationSignupLimitMessage =
  "You can book one upcoming orientation at a time until your first orientation is marked completed. Unregister from your current orientation before choosing another.";

export const orientationFullMessage =
  "All four places for volunteers who have not completed orientation are booked.";
export const orientationReservedMessage =
  "The remaining places are reserved for volunteers who have not completed orientation.";

export const orientationCapacityMessage =
  "Patrols that include orientation need at least 2 total volunteer spots. Increase capacity to 2 or turn off Includes orientation.";

export function validOrientationCapacity(event: {
  includesOrientation: boolean | number;
  spots: number;
}) {
  return !event.includesOrientation || event.spots >= 2;
}

export function eventIncludesOrientation(
  event: Pick<SignupEvent, "includesOrientation" | "type">,
) {
  return Boolean(event.includesOrientation ?? event.type === "orientation");
}

/** Capacity for this volunteer's category, before access/booking-policy checks. */
export function availableSignupSpots(
  event: Pick<
    SignupEvent,
    | "type"
    | "includesOrientation"
    | "spots"
    | "orientationConfirmed"
    | "orientationCompleted"
  >,
  confirmed: number,
) {
  const total = Math.max(0, event.spots - confirmed);
  if (!eventIncludesOrientation(event)) return total;
  const firstTimers = event.orientationConfirmed ?? 0;
  const category = event.orientationCompleted
    ? event.spots - Math.min(2, event.spots) - (confirmed - firstTimers)
    : 4 - firstTimers;
  return Math.max(0, Math.min(total, category));
}

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
  const includesOrientation = eventIncludesOrientation(event);
  if (!includesOrientation && !volunteer.patrolApproved)
    return "Organizer approval is required to register for patrols.";
  if (confirmed >= event.spots) return "This event is full.";
  if (includesOrientation && !availableSignupSpots(event, confirmed))
    return event.orientationCompleted
      ? orientationReservedMessage
      : orientationFullMessage;
  if (includesOrientation && event.orientationSignupBlocked)
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
