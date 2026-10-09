import { RequestError } from "../http";

/** Translate database invariants into responses without exposing SQL or values. */
export function databaseWriteError(error: unknown): never {
  if (error instanceof RequestError) throw error;
  const message =
    error instanceof Error
      ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
      : "";
  if (message.includes("event_full"))
    throw new RequestError(409, "This event is full.");
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
