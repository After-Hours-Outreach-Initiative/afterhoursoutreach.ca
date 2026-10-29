import assert from "node:assert/strict";
import { test } from "vitest";
import { contactEmail } from "../src/data/site";
import {
  canViewVolunteerProfile,
  availableSignupSpots,
  orientationFullMessage,
  orientationReservedMessage,
  orientationSignupLimitMessage,
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
  applicationSubmitted: true,
  applicationApproved: true,
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

test("application-approved volunteers need no patrol approval for orientations", () => {
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

test("an existing first-orientation booking shows the cancellation/rebooking reason", () => {
  assert.equal(
    signupBlockReason(
      { ...volunteer, patrolApproved: false },
      { ...event, type: "orientation", orientationSignupBlocked: true },
      0,
      now,
    ),
    orientationSignupLimitMessage,
  );
});

test("availability and block reasons use orientation completion, total capacity and category limits", () => {
  const patrol = {
    ...event,
    includesOrientation: true,
    orientationConfirmed: 0,
    orientationCompleted: true,
    medicConfirmed: 2,
  };
  assert.equal(availableSignupSpots(patrol, 6), 0);
  assert.equal(
    signupBlockReason(volunteer, patrol, 6, now),
    orientationReservedMessage,
  );
  assert.equal(
    availableSignupSpots({ ...patrol, orientationCompleted: false }, 6),
    2,
  );
  const newFull = {
    ...patrol,
    orientationConfirmed: 4,
    medicConfirmed: 0,
    orientationCompleted: false,
  };
  assert.equal(
    signupBlockReason(volunteer, newFull, 4, now),
    orientationFullMessage,
  );
  assert.equal(
    availableSignupSpots({ ...newFull, orientationCompleted: true }, 4),
    2,
  );
  assert.equal(
    availableSignupSpots({ ...patrol, orientationConfirmed: 2 }, 8),
    0,
  );
});

test("dynamic reservations share extras but never consume outstanding places; first-time medics are new volunteers only", () => {
  const base = {
    ...event,
    includesOrientation: true,
    orientationCompleted: true,
    orientationConfirmed: 0,
    medicConfirmed: 0,
    medicEligible: false,
  };
  assert.equal(availableSignupSpots(base, 0), 4);
  assert.equal(availableSignupSpots({ ...base, medicEligible: true }, 0), 6);
  assert.equal(
    availableSignupSpots(
      { ...base, orientationCompleted: false, medicEligible: true },
      0,
    ),
    4,
  );
  assert.equal(
    availableSignupSpots({ ...base, orientationConfirmed: 3 }, 3),
    3,
  );
  assert.equal(availableSignupSpots({ ...base, medicConfirmed: 3 }, 3), 3);
  assert.equal(
    availableSignupSpots({ ...base, orientationConfirmed: 4 }, 6),
    0,
  );
  assert.equal(
    availableSignupSpots({ ...base, includesOrientation: false }, 6),
    0,
  );
  assert.equal(
    availableSignupSpots(
      { ...base, includesOrientation: false, medicEligible: true },
      6,
    ),
    2,
  );
});

test("pending applications cannot sign up for any event; organizers retain access", () => {
  for (const type of ["patrol", "orientation"] as const) {
    const pending = { ...volunteer, applicationApproved: false };
    assert.match(
      signupBlockReason(pending, { ...event, type }, 0, now)!,
      /awaiting organizer approval/,
    );
    assert.equal(
      signupBlockReason(
        { ...pending, role: "organizer" },
        { ...event, type },
        0,
        now,
      ),
      null,
    );
  }
});

test("sign-in, application and active status are required", () => {
  assert.equal(signupBlockReason(null, event, 0, now), "Sign in to register.");
  assert.equal(
    signupBlockReason(
      { ...volunteer, applicationSubmitted: false },
      event,
      0,
      now,
    )!,
    "Complete your volunteer application before registering for events.",
  );
  assert.equal(
    signupBlockReason({ ...volunteer, active: false }, event, 0, now)!,
    `Your volunteer account is inactive. Contact an organizer at ${contactEmail} to restore access.`,
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
