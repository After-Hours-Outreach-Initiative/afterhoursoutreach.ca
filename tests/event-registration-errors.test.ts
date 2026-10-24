import assert from "node:assert/strict";
import { test } from "vitest";
import { databaseWriteError } from "../src/server/db/errors";
import { RequestError } from "../src/server/http";
import {
  orientationCapacityMessage,
  orientationReservedMessage,
  orientationSignupLimitMessage,
} from "../src/server/db/policy";

for (const [invariant, status, message] of [
  ["orientation_signup_limit", 409, orientationSignupLimitMessage],
  ["orientation_minimum_capacity", 400, orientationCapacityMessage],
  ["event_minimum_capacity", 400, orientationCapacityMessage],
  ["signup_places_reserved", 409, orientationReservedMessage],
  [
    "signup_not_eligible",
    403,
    "This event is closed or you are not eligible to register.",
  ],
  [
    "capacity_below_signups",
    409,
    "Capacity cannot be lower than the number of registrations.",
  ],
  [
    "UNIQUE constraint failed: signup.event_id, signup.user_id",
    409,
    "You are already registered for this event.",
  ],
] as const) {
  test(`${invariant} keeps its identifier and returns event registration wording`, () => {
    assert.throws(
      () => databaseWriteError(new Error(invariant)),
      (error: unknown) =>
        error instanceof RequestError &&
        error.status === status &&
        error.message === message,
    );
  });
}
