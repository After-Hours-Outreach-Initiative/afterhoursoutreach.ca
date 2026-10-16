import { expect, test } from "vitest";
import type { Actor } from "../src/server/db/access";
import type { EventRow } from "../src/server/db/events";
import { eventViewVersion } from "../src/server/events/version";

test("view versions detect capacity, signups, visibility and access changes without sending details", async () => {
  const event: EventRow = {
    id: "event",
    type: "orientation",
    startsAt: 2_000_000_000_000,
    meetingPoint: "Meeting point",
    meetingPointUrl: null,
    spots: 1,
    open: 1,
    hidden: 0,
    cancelledAt: null,
    updatedAt: 1,
    confirmed: 0,
    signedUp: 0,
    orientationSignupBlocked: 0,
  };
  const actor: Actor = {
    id: "volunteer",
    name: "Volunteer",
    sessionId: "session",
    role: "volunteer",
    applicationSubmitted: true,
    applicationApproved: true,
    active: true,
    patrolApproved: false,
    twoFactorEnabled: false,
    twoFactorVerified: false,
  };
  const original = await eventViewVersion([event], actor);
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  expect(await eventViewVersion([event], actor)).toBe(original);
  for (const update of [
    { confirmed: 1 },
    { signedUp: 1 },
    { orientationSignupBlocked: 1 },
    { spots: 2 },
    { open: 0 },
    { hidden: 1 },
    { cancelledAt: 1 },
  ])
    expect(await eventViewVersion([{ ...event, ...update }], actor)).not.toBe(
      original,
    );
  expect(await eventViewVersion([], actor)).not.toBe(original);
  expect(await eventViewVersion([event], null)).not.toBe(original);
  expect(await eventViewVersion([event], { ...actor, active: false })).not.toBe(
    original,
  );
  expect(
    await eventViewVersion([event], { ...actor, applicationApproved: false }),
  ).not.toBe(original);
  expect(
    await eventViewVersion([event], { ...actor, sessionId: "renewed" }),
  ).toBe(original);
});
