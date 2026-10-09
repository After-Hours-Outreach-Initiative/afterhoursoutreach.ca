import assert from "node:assert/strict";
import { test } from "vitest";
import { databaseWriteError } from "../src/server/db/errors";
import { RequestError } from "../src/server/http";

for (const [invariant, status, message] of [
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
