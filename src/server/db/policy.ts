import { contactEmail } from "../../data/site";
import {
  defaultEventLimits,
  minimumEventSpots,
  type EventLimits,
} from "../../data/event-limits";

// User-facing previews of the rules enforced by database writes and triggers.sql.
export interface SignupVolunteer {
  applicationSubmitted: boolean;
  active: boolean;
  applicationApproved: boolean;
  patrolApproved: boolean;
  role?: "volunteer" | "organizer";
}

export interface SignupEvent extends Partial<EventLimits> {
  // Legacy callers can keep supplying type; new forms use includesOrientation.
  type?: "patrol" | "orientation";
  includesOrientation?: boolean | number;
  startsAt: Date;
  open: boolean;
  spots: number;
  newVolunteerConfirmed?: number;
  medicConfirmed?: number;
  // Server-derived: team selection and both manual organizer approvals.
  medicEligible?: boolean | number;
  orientationSignupBlocked?: boolean;
}

export const orientationSignupLimitMessage =
  "You can book one upcoming orientation at a time until an organizer approves you for patrols. Unregister from your current orientation before choosing another.";

export const orientationFullMessage = "All new volunteer places are booked.";
export const orientationReservedMessage =
  "The remaining places are reserved for approved medics or new volunteers awaiting patrol approval.";

export const orientationCapacityMessage =
  "Volunteer spots must cover the reserved medic places and, with orientation, reserved new volunteer places. The new volunteer maximum cannot be below its reserved places.";

export function validOrientationCapacity(
  event: Partial<EventLimits> & {
    includesOrientation: boolean | number;
    spots: number;
  },
) {
  return (
    event.spots >= minimumEventSpots(event) &&
    (event.minNewVolunteerSpots ?? defaultEventLimits.minNewVolunteerSpots) <=
      (event.maxNewVolunteers ?? defaultEventLimits.maxNewVolunteers)
  );
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
    | "newVolunteerConfirmed"
    | "medicConfirmed"
    | "medicEligible"
    | keyof EventLimits
  >,
  confirmed: number,
  volunteer: Pick<SignupVolunteer, "patrolApproved">,
) {
  const orientation = eventIncludesOrientation(event);
  const newVolunteer = orientation && !volunteer.patrolApproved;
  const medic = !newVolunteer && Boolean(event.medicEligible);
  const medics = event.medicConfirmed ?? 0;
  const newVolunteers = event.newVolunteerConfirmed ?? 0;
  const limits = { ...defaultEventLimits, ...event };
  // Try successive additions in the viewer's mutually exclusive category. Each
  // addition must leave room for BOTH categories' outstanding reservations.
  let available = 0;
  for (let added = 1; added <= event.spots - confirmed; added++) {
    const afterNewVolunteers = newVolunteers + (newVolunteer ? added : 0);
    if (newVolunteer && afterNewVolunteers > limits.maxNewVolunteers) break;
    const outstandingMedics = Math.max(
      0,
      limits.minMedicSpots - medics - (medic ? added : 0),
    );
    const outstandingNewVolunteers = orientation
      ? Math.max(0, limits.minNewVolunteerSpots - afterNewVolunteers)
      : 0;
    if (
      confirmed + added + outstandingMedics + outstandingNewVolunteers >
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
  if (!availableSignupSpots(event, confirmed, volunteer))
    return includesOrientation &&
      !volunteer.patrolApproved &&
      (event.newVolunteerConfirmed ?? 0) >=
        (event.maxNewVolunteers ?? defaultEventLimits.maxNewVolunteers)
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
