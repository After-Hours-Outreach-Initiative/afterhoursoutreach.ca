import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { emailOutcome, sendEmail } from "../src/server/email";
import { emailError, emailSender } from "./helpers/email-sender";

afterEach(() => vi.useRealTimers());

const payload = {
  from: "After Hours Outreach <info@afterhoursoutreach.ca>",
  to: ["volunteer@example.org"],
  subject: "Subject",
  text: "Body",
};

test("frozen payloads become Cloudflare messages with a named sender", async () => {
  const sender = emailSender();
  assert.equal(
    await sendEmail(sender, { ...payload, html: "<p>Body</p>" }),
    "sent",
  );
  assert.deepEqual(sender.messages[0], {
    from: { name: "After Hours Outreach", email: "info@afterhoursoutreach.ca" },
    to: ["volunteer@example.org"],
    subject: "Subject",
    text: "Body",
    html: "<p>Body</p>",
  });
  await sendEmail(sender, { ...payload, from: "info@afterhoursoutreach.ca" });
  assert.equal(sender.messages[1].from, "info@afterhoursoutreach.ca");
});

test("only errors raised before sending are retryable", () => {
  assert.equal(emailOutcome(emailError("E_RECIPIENT_SUPPRESSED")), "failed");
  assert.equal(emailOutcome(emailError("E_HEADER_NOT_ALLOWED")), "failed");
  assert.equal(emailOutcome(new TypeError("bad message")), "failed");
  assert.equal(emailOutcome(emailError("E_RATE_LIMIT_EXCEEDED")), "limited");
  assert.equal(emailOutcome(emailError("E_DAILY_LIMIT_EXCEEDED")), "limited");
  assert.equal(
    emailOutcome(emailError("E_INTERNAL_SERVER_ERROR")),
    "unconfirmed",
  );
  assert.equal(emailOutcome(emailError("E_DELIVERY_FAILED")), "unconfirmed");
  assert.equal(emailOutcome(new Error("network")), "unconfirmed");
});

test("a send that outlasts its timeout is unconfirmed", async () => {
  vi.useFakeTimers();
  const result = sendEmail(
    emailSender(() => new Promise(() => {})),
    payload,
    1000,
  );
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(await result, "unconfirmed");
});
