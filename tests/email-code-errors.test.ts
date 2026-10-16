import assert from "node:assert/strict";
import { test } from "vitest";
import { emailCodeErrorMessage } from "../src/scripts/account-forms";

test("expired and consumed email proofs explain same-email recovery", () => {
  assert.equal(
    emailCodeErrorMessage({
      error: { code: "OTP_EXPIRED", message: "OTP expired" },
    }),
    "That sign-in code has expired. Choose Resend code for a new code and link sent to the same email.",
  );
  assert.equal(
    emailCodeErrorMessage({
      error: { code: "INVALID_OTP", message: "Invalid OTP" },
    }),
    "Invalid sign-in code. It may be incorrect, expired, or already used. Try the latest email or choose Resend code.",
  );
});

test("email recovery preserves network, service, rate-limit and custom API errors", () => {
  for (const [error, expected] of [
    [
      new TypeError("Failed to fetch"),
      "We could not connect. Check your connection and try again.",
    ],
    [
      { status: 503 },
      "This service is temporarily unavailable. Please try again later.",
    ],
    [{ status: 429 }, "Too many requests. Please wait before trying again."],
    [
      { error: { message: "That code is incorrect or has expired." } },
      "That code is incorrect or has expired.",
    ],
    [null, "The request failed. Please try again."],
  ] as const)
    assert.equal(emailCodeErrorMessage(error), expected);
});
