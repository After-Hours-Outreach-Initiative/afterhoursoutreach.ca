import { expect, test } from "vitest";
import type { Actor } from "../src/server/db/access";
import type { EventRow } from "../src/server/db/events";
import { eventViewVersion } from "../src/server/events/version";

test("view versions detect capacity, signups, visibility and access changes without sending details", async () => {
  const event: EventRow = {
    id: "event",
    type: "orientation",
    includesOrientation: 1,
    seriesId: null,
    occurrenceDate: null,
    inSignupWindow: 1,
    startsAt: 2_000_000_000_000,
    meetingPoint: "Meeting point",
    meetingPointUrl: null,
    spots: 1,
    minMedicSpots: 2,
    minNewVolunteerSpots: 2,
    maxNewVolunteers: 4,
    open: 1,
    hidden: 0,
    cancelledAt: null,
    updatedAt: 1,
    confirmed: 0,
    newVolunteerConfirmed: 0,
    medicConfirmed: 0,
    medicEligible: 0,
    orientationCompleted: 0,
    availableSpots: 1,
    futureConfirmed: 0,
    futureEditableConfirmed: 0,
    signedUp: 0,
    orientationSignupBlocked: 0,
  };
  const actor: Actor = {
    id: "volunteer",
    name: "Volunteer",
    sessionId: "session",
    role: "volunteer",
    applicationSubmitted: true,
    applicationComplete: true,
    naloxoneCompleted: true,
    applicationApproved: true,
    active: true,
    patrolApproved: false,
    twoFactorEnabled: false,
    twoFactorVerified: false,
  };
  const original = await eventViewVersion([event], actor);
  const publicRoster = {
    people: [
      {
        eventId: event.id,
        name: "Alice P.",
        category: "new-volunteer" as const,
        medicMark: 0,
      },
    ],
    version: "membership-one",
  };
  const publicVersion = await eventViewVersion(
    [event],
    actor,
    [],
    undefined,
    [],
    publicRoster,
  );
  for (const update of [
    { ...publicRoster, version: "membership-two" },
    {
      ...publicRoster,
      people: [{ ...publicRoster.people[0], name: "Alex P." }],
    },
    {
      ...publicRoster,
      people: [{ ...publicRoster.people[0], medicMark: 1 }],
    },
    {
      ...publicRoster,
      people: [
        { ...publicRoster.people[0], category: "outreach-volunteer" as const },
      ],
    },
  ]) {
    expect(
      await eventViewVersion([event], actor, [], undefined, [], update),
    ).not.toBe(publicVersion);
    const pending = { ...actor, applicationApproved: false };
    expect(await eventViewVersion([], pending, [], undefined, [], update)).toBe(
      await eventViewVersion([], pending),
    );
  }
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  expect(await eventViewVersion([event], actor)).toBe(original);
  for (const update of [
    { confirmed: 1 },
    { includesOrientation: 0 },
    { newVolunteerConfirmed: 1 },
    { orientationCompleted: 1 },
    { availableSpots: 0 },
    { futureConfirmed: 1 },
    { futureEditableConfirmed: 1 },
    { signedUp: 1 },
    { orientationSignupBlocked: 1 },
    { spots: 2 },
    { minMedicSpots: 3 },
    { minNewVolunteerSpots: 1 },
    { maxNewVolunteers: 5 },
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
    await eventViewVersion([], { ...actor, applicationComplete: false }),
  ).not.toBe(await eventViewVersion([], actor));
  const pendingApplicant = {
    ...actor,
    applicationApproved: false,
    applicationComplete: false,
    naloxoneCompleted: false,
  };
  const pendingVersion = await eventViewVersion([], pendingApplicant);
  expect(pendingVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await eventViewVersion([], {
      ...pendingApplicant,
      naloxoneCompleted: true,
    }),
  ).not.toBe(pendingVersion);
  expect(
    await eventViewVersion([event], { ...actor, sessionId: "renewed" }),
  ).toBe(original);

  const organizer: Actor = { ...actor, role: "organizer" };
  const roster = [
    {
      id: "signup",
      eventId: event.id,
      userId: "attendee",
      name: "Attendee",
      registeredAt: 1,
      completed: 0,
      patrolApproved: 0,
      statusVersion: 0,
      category: "new-volunteer" as const,
      medicMark: 0,
    },
  ];
  const rosterVersion = await eventViewVersion([event], organizer, roster);
  for (const change of [
    { id: "replacement-signup", userId: "replacement-attendee" },
    { name: "Updated name" },
    { registeredAt: 2 },
    { completed: 1 },
    { patrolApproved: 1 },
    { statusVersion: 1 },
    { category: "medic" as const },
    { medicMark: 1 },
  ]) {
    const updated = [{ ...roster[0], ...change }];
    expect(await eventViewVersion([event], organizer, updated)).not.toBe(
      rosterVersion,
    );
    expect(await eventViewVersion([event], actor, updated)).toBe(original);
  }
  expect(
    await eventViewVersion([event], organizer, roster, event.startsAt - 1),
  ).not.toBe(
    await eventViewVersion([event], organizer, roster, event.startsAt),
  );
});
