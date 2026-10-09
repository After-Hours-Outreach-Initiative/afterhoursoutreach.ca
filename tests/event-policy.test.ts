import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canViewVolunteerProfile,
  signupBlockReason,
  type SignupEvent,
  type SignupVolunteer,
} from "../src/server/db/policy";

const now = new Date("2026-10-01T19:00:00Z");
const event: SignupEvent = {
  type: "patrol",
  startsAt: new Date("2026-10-02T03:30:00Z"),
  open: true,
  spots: 8,
};
const volunteer: SignupVolunteer = {
  registered: true,
  active: true,
  patrolApproved: true,
};

test("approval allows patrol signup without orientation completion", () => {
  assert.equal(signupBlockReason(volunteer, event, 0, now), null);
});

test("patrols require explicit approval", () => {
  assert.equal(
    signupBlockReason({ ...volunteer, patrolApproved: false }, event, 0, now)!,
    "Organizer approval is required to register for patrols.",
  );
});

test("unapproved volunteers can sign up for orientations", () => {
  assert.equal(
    signupBlockReason(
      { ...volunteer, patrolApproved: false },
      { ...event, type: "orientation" },
      0,
      now,
    ),
    null,
  );
});

test("sign-in, registration and active status are required", () => {
  assert.equal(signupBlockReason(null, event, 0, now), "Sign in to register.");
  assert.equal(
    signupBlockReason({ ...volunteer, registered: false }, event, 0, now)!,
    "Complete volunteer registration before registering for events.",
  );
  assert.match(
    signupBlockReason({ ...volunteer, active: false }, event, 0, now)!,
    /inactive/,
  );
});

test("full, closed, started and invalid-date events reject signups", () => {
  assert.match(signupBlockReason(volunteer, event, 8, now)!, /full/);
  assert.match(
    signupBlockReason(volunteer, { ...event, open: false }, 0, now)!,
    /closed/,
  );
  for (const startsAt of [now, new Date(0), new Date("invalid")]) {
    assert.equal(
      signupBlockReason(volunteer, { ...event, startsAt }, 0, now)!,
      "Registration closes when the event starts.",
    );
  }
});

test("organizer profile access requires two-factor only when enabled", () => {
  for (const role of ["volunteer", "organizer"] as const) {
    for (const twoFactorEnabled of [false, true]) {
      for (const twoFactorVerified of [false, true]) {
        assert.equal(
          canViewVolunteerProfile({
            role,
            twoFactorEnabled,
            twoFactorVerified,
          }),
          role === "organizer" && (!twoFactorEnabled || twoFactorVerified),
        );
      }
    }
  }
});
