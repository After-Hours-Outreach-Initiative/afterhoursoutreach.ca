import assert from "node:assert/strict";
import { test } from "vitest";
import { accountErrorMessage } from "../src/scripts/account-forms";

test("auth errors use the API message instead of Better Fetch's HTTP status", () => {
  const error = Object.assign(new Error("429"), {
    status: 429,
    statusText: "",
    error: { message: "Wait one minute before requesting another email." },
  });
  assert.equal(
    accountErrorMessage(error),
    "Wait one minute before requesting another email.",
  );
  assert.equal(
    accountErrorMessage({
      status: 400,
      statusText: "Bad Request",
      message: "Bad Request",
      error: { message: "That code is incorrect or has expired." },
    }),
    "That code is incorrect or has expired.",
  );
});

test("empty rate-limit and service errors have readable fallbacks", () => {
  assert.equal(
    accountErrorMessage(Object.assign(new Error("429"), { status: 429 })),
    "Too many requests. Please wait before trying again.",
  );
  assert.equal(
    accountErrorMessage({ status: 503, message: "Service Unavailable" }),
    "This service is temporarily unavailable. Please try again later.",
  );
  assert.equal(
    accountErrorMessage(new Error("400")),
    "The request failed. Please try again.",
  );
  assert.equal(
    accountErrorMessage(new TypeError("Failed to fetch")),
    "We could not connect. Check your connection and try again.",
  );
});
