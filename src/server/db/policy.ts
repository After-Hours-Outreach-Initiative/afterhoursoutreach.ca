import { contactEmail } from "../../data/site";

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
  medicConfirmed?: number;
  // Server-derived: team selection, both organizer approvals and completion.
  medicEligible?: boolean | number;
  // Whether the current volunteer has ANY recorded orientation completion.
  orientationCompleted?: boolean | number;
  orientationSignupBlocked?: boolean;
}

export const orientationSignupLimitMessage =
  "You can book one upcoming orientation at a time until your first orientation is marked completed. Unregister from your current orientation before choosing another.";

export const orientationFullMessage =
  "All four places for volunteers who have not completed orientation are booked.";
export const orientationReservedMessage =
  "The remaining places are reserved for approved medics or volunteers who have not completed orientation.";

export const orientationCapacityMessage =
  "Patrols need at least 2 total volunteer spots, or 4 when including orientation, to preserve reserved places.";

export function validOrientationCapacity(event: {
  includesOrientation: boolean | number;
  spots: number;
}) {
  return event.spots >= (event.includesOrientation ? 4 : 2);
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
    | "medicConfirmed"
    | "medicEligible"
  >,
  confirmed: number,
) {
  const orientation = eventIncludesOrientation(event);
  const orientee = orientation && !event.orientationCompleted;
  const medic = !orientee && Boolean(event.medicEligible);
  const medics = event.medicConfirmed ?? 0;
  const orientees = event.orientationConfirmed ?? 0;
  // Try successive additions in the viewer's mutually exclusive category. Each
  // addition must leave room for BOTH categories' outstanding reservations.
  let available = 0;
  for (let added = 1; added <= event.spots - confirmed; added++) {
    const afterOrientees = orientees + (orientee ? added : 0);
    if (orientee && afterOrientees > 4) break;
    const outstandingMedics = Math.max(0, 2 - medics - (medic ? added : 0));
    const outstandingOrientees = orientation
      ? Math.max(0, 2 - afterOrientees)
      : 0;
    if (
      confirmed + added + outstandingMedics + outstandingOrientees >
      event.spots
    )
      break;
    available = added;
  }
  return available;
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
  if (!volunteer.active)
    return `Your volunteer account is inactive. Contact an organizer at ${contactEmail} to restore access.`;
  if (!volunteer.applicationApproved && volunteer.role !== "organizer")
    return "Your application is awaiting organizer approval.";
  return eventSignupBlockReason(volunteer, event, confirmed, now);
}

/** Event feedback for viewers already admitted by canViewEvents; not authorization. */
export function eventSignupBlockReason(
  volunteer: Pick<SignupVolunteer, "patrolApproved">,
  event: SignupEvent,
  confirmed: number,
  now = new Date(),
): string | null {
  if (!event.open) return "This event is closed.";
  if (!Number.isFinite(event.startsAt.getTime()) || event.startsAt <= now)
    return "Registration closes when the event starts.";
  const includesOrientation = eventIncludesOrientation(event);
  if (!includesOrientation && !volunteer.patrolApproved)
    return "Organizer approval is required to register for patrols.";
  if (confirmed >= event.spots) return "This event is full.";
  if (!availableSignupSpots(event, confirmed))
    return includesOrientation &&
      !event.orientationCompleted &&
      (event.orientationConfirmed ?? 0) >= 4
      ? orientationFullMessage
      : orientationReservedMessage;
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
