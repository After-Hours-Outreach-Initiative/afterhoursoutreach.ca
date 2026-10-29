import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  forgetSignInEmails,
  rememberedSignInEmails,
  rememberSuccessfulSignIn,
} from "../src/scripts/sign-in-history";

let stored: Map<string, string>;
const success = (email: string) => ({
  token: "session-secret-never-store",
  user: { id: "user-id", email },
});

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

test("successful sign-ins store only five recent, unique email addresses", () => {
  assert.deepEqual(rememberedSignInEmails(), []);
  for (let index = 0; index < 6; index++)
    rememberSuccessfulSignIn(success(`person${index}@example.org`));
  rememberSuccessfulSignIn(success("  PERSON3@EXAMPLE.ORG  "));
  const expected = [3, 5, 4, 2, 1].map((index) => `person${index}@example.org`);
  assert.deepEqual(rememberedSignInEmails(), expected);
  assert.deepEqual([...stored.values()], [JSON.stringify(expected)]);
  forgetSignInEmails();
  assert.equal(stored.size, 0);
});

test("attempts, delivery responses and unfinished two-factor challenges are not remembered", () => {
  for (const result of [
    { email: "attempt@example.org" },
    {
      success: true,
      localEmail: { email: "sent@example.org", code: "123456" },
    },
    { user: { email: "no-session@example.org" } },
    { ...success("pending@example.org"), twoFactorRedirect: true },
    success("not-an-email"),
  ])
    rememberSuccessfulSignIn(result);
  assert.equal(stored.size, 0);
  // The same completed response shape is returned by OTP, TOTP and backup-code sign-in.
  rememberSuccessfulSignIn(success("verified@example.org"));
  assert.deepEqual(rememberedSignInEmails(), ["verified@example.org"]);
});

test("invalid history is ignored and recovered on the next successful sign-in", () => {
  for (const value of ["invalid json", "null", '{"email":"old@example.org"}']) {
    stored.set("aho:sign-in-emails:v1", value);
    assert.deepEqual(rememberedSignInEmails(), []);
  }
  stored.set(
    "aho:sign-in-emails:v1",
    '[null, 12, "bad", "GOOD@example.org", "good@example.org"]',
  );
  assert.deepEqual(rememberedSignInEmails(), ["good@example.org"]);
  rememberSuccessfulSignIn(success("new@example.org"));
  assert.deepEqual(rememberedSignInEmails(), [
    "new@example.org",
    "good@example.org",
  ]);
});

test("unavailable browser storage never interrupts sign-in", () => {
  vi.stubGlobal("localStorage", {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  });
  assert.deepEqual(rememberedSignInEmails(), []);
  assert.doesNotThrow(() =>
    rememberSuccessfulSignIn(success("valid@example.org")),
  );
  assert.doesNotThrow(forgetSignInEmails);
});
