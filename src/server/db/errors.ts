import { RequestError } from "../http";
import {
  orientationFullMessage,
  orientationReservedMessage,
  orientationSignupLimitMessage,
  orientationCapacityMessage,
} from "./policy";

/** Translate database invariants into responses without exposing SQL or values. */
export function databaseWriteError(error: unknown): never {
  if (error instanceof RequestError) throw error;
  const message =
    error instanceof Error
      ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
      : "";
  if (message.includes("event_full"))
    throw new RequestError(409, "This event is full.");
  if (
    message.includes("orientation_minimum_capacity") ||
    message.includes("event_minimum_capacity")
  )
    throw new RequestError(400, orientationCapacityMessage);
  if (message.includes("orientation_places_full"))
    throw new RequestError(409, orientationFullMessage);
  if (
    message.includes("orientation_places_reserved") ||
    message.includes("signup_places_reserved")
  )
    throw new RequestError(409, orientationReservedMessage);
  if (message.includes("orientation_edit_conflict"))
    throw new RequestError(
      409,
      "These changes conflict with existing registrations or completion history. Keep two medic places and, with orientation, two orientee places reserved (maximum four orientees). Retain orientation where booked volunteers need it.",
    );
  if (message.includes("orientation_signup_limit"))
    throw new RequestError(409, orientationSignupLimitMessage);
  if (message.includes("recurring_signup_window"))
    throw new RequestError(
      409,
      "Registration is available only for the next three patrol occurrences in this series.",
    );
  if (message.includes("signup_not_eligible"))
    throw new RequestError(
      403,
      "This event is closed or you are not eligible to register.",
    );
  if (message.includes("capacity_below_signups"))
    throw new RequestError(
      409,
      "Capacity cannot be lower than the number of registrations.",
    );
  if (message.includes("last_organizer"))
    throw new RequestError(409, "Keep at least one active organizer.");
  if (message.includes("UNIQUE constraint failed: signup"))
    throw new RequestError(409, "You are already registered for this event.");
  throw error;
}
