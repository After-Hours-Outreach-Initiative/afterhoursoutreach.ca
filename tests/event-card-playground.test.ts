import { describe, expect, test } from "vitest";
import {
  createEventCardFixture,
  eventCardScenarios,
} from "../src/dev/ui/event-card-fixtures";
import { eventSignupBlockReason } from "../src/server/db/policy";

const now = Date.UTC(2030, 0, 1);

describe("event card playground fixtures", () => {
  test("all scenarios have distinct IDs and internally consistent rosters", () => {
    expect(new Set(eventCardScenarios.map(({ id }) => id)).size).toBe(
      eventCardScenarios.length,
    );
    for (const scenario of eventCardScenarios) {
      const fixture = createEventCardFixture(scenario.id, undefined, now);
      const { event, publicRoster } = fixture;
      expect(createEventCardFixture(scenario.id, undefined, now)).toEqual(
        fixture,
      );
      expect(event.confirmed).toBe(publicRoster.length);
      expect(event.confirmed).toBeLessThanOrEqual(event.spots);
      expect(event.medicConfirmed).toBe(
        publicRoster.filter(({ category }) => category === "medic").length,
      );
      expect(event.newVolunteerConfirmed).toBe(
        publicRoster.filter(({ category }) => category === "new-volunteer")
          .length,
      );
      expect(publicRoster.every(({ eventId }) => eventId === event.id)).toBe(
        true,
      );
      expect(event.startsAt).toBeGreaterThan(now);
      expect(event.availableSpots).toBeGreaterThanOrEqual(0);
    }
  });

  test("the default full card contains all three volunteer types and exactly eight people", () => {
    const { event, actor, scenario, publicRoster } = createEventCardFixture(
      null,
      undefined,
      now,
    );
    expect(scenario.id).toBe("full");
    expect(event).toMatchObject({
      spots: 8,
      confirmed: 8,
      medicConfirmed: 2,
      newVolunteerConfirmed: 4,
      availableSpots: 0,
    });
    expect(publicRoster.filter(({ medicMark }) => medicMark)).toHaveLength(3);
    expect(
      publicRoster.filter(
        ({ category, medicMark }) => category === "new-volunteer" && medicMark,
      ),
    ).toHaveLength(1);
    expect(
      eventSignupBlockReason(
        actor,
        {
          ...event,
          startsAt: new Date(event.startsAt),
          open: true,
          orientationSignupBlocked: false,
        },
        event.confirmed,
        new Date(now),
      ),
    ).toBe("This event is full.");
    expect(createEventCardFixture("unknown", undefined, now).scenario.id).toBe(
      "full",
    );
  });

  test("local registration adds the viewer in the correct category and supports cancellation", () => {
    for (const id of ["mixed", "new-volunteers", "one-left", "registered"]) {
      const before = createEventCardFixture(id, false, now);
      const after = createEventCardFixture(id, true, now);
      expect(after.event.signedUp).toBe(1);
      expect(after.event.confirmed).toBe(before.event.confirmed + 1);
      expect(after.publicRoster.at(-1)).toMatchObject({
        name: "Morgan P.",
        category:
          id === "new-volunteers" ? "new-volunteer" : "outreach-volunteer",
      });
      expect(createEventCardFixture(id, false, now)).toEqual(before);
    }
    expect(
      createEventCardFixture("registered", undefined, now).event.signedUp,
    ).toBe(1);
    expect(createEventCardFixture("full", true, now).event).toMatchObject({
      signedUp: 0,
      confirmed: 8,
    });
    expect(
      createEventCardFixture("one-left", true, now).event.availableSpots,
    ).toBe(0);
  });
});
