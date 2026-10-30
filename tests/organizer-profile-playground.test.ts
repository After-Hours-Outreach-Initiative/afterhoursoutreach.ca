import { describe, expect, test } from "vitest";
import {
  createProfileFixture,
  organizerProfileScenarios,
  profileQuery,
  profileSimulationState,
  profileStateQuery,
  readProfileOptions,
  readProfileState,
} from "../src/dev/ui/organizer-profile-fixtures";

describe("organizer profile playground fixtures", () => {
  test("every listed state has a deterministic, internally consistent fictional profile", () => {
    expect(organizerProfileScenarios).toHaveLength(16);
    expect(new Set(organizerProfileScenarios.map(({ id }) => id)).size).toBe(
      16,
    );
    for (const scenario of organizerProfileScenarios) {
      const options = readProfileOptions(
        new URLSearchParams({ scenario: scenario.id }),
      );
      const fixture = createProfileFixture(options);
      expect(createProfileFixture(options)).toEqual(fixture);
      expect(fixture.person.id).toBe("ui-fictional-volunteer");
      expect(fixture.profile.email).toMatch(/@example\.org$/);
      expect(fixture.progress.applicationApproved).toBe(
        Boolean(fixture.person.applicationApproved),
      );
      expect(fixture.progress.applicationRejectionReason).toBe(
        fixture.person.applicationRejectionReason,
      );
      expect(fixture.profile.naloxoneCompletedAt).toBe(
        fixture.progress.naloxoneCompletedAt,
      );
      expect(Boolean(fixture.completedOrientation)).toBe(
        fixture.person.orientations > 0,
      );
      if (fixture.person.patrolApproved)
        expect(fixture.person.applicationApproved).toBe(1);
      if (!fixture.person.applicationApproved)
        expect(fixture.profile.applicationApprovedBy).toBeNull();
      expect(fixture.progress.submittedAt).not.toBeNull();
    }
  });

  test("normalizes bookmarkable controls and constrains untrusted query values", () => {
    const options = readProfileOptions(
      new URLSearchParams({
        scenario: "unknown",
        surface: "unknown",
        viewport: "99999",
        content: "unknown",
        phase: "unknown",
        outcome: "unknown",
        latency: "Infinity",
        height: "99999",
      }),
    );
    expect(options).toEqual({
      scenario: "ready-for-review",
      viewport: "fit",
      content: "standard",
      phase: "ready",
      outcome: "success",
      latency: 600,
      height: 1200,
    });
    expect(readProfileOptions(profileQuery(options))).toEqual(options);
    expect(
      readProfileOptions(new URLSearchParams({ surface: "dialog" })),
    ).not.toHaveProperty("surface");
    expect(
      readProfileOptions(
        new URLSearchParams({ latency: "-100", height: "-20" }),
      ),
    ).toMatchObject({ latency: 0, height: 360 });
  });

  test("keeps historical submissions separate from changed profile answers", () => {
    const fixture = createProfileFixture(
      readProfileOptions(new URLSearchParams({ scenario: "profile-updated" })),
    );
    expect(fixture.profile.answers.phone).not.toBe(
      fixture.profile.submission!.answers.phone,
    );
    expect(fixture.profile.email).not.toBe(fixture.profile.submission!.email);
    fixture.profile.answers.teams.push("medic");
    expect(fixture.profile.submission!.answers.teams).toEqual(["outreach"]);
    expect(
      createProfileFixture(
        readProfileOptions(
          new URLSearchParams({ scenario: "legacy-application" }),
        ),
      ).profile.submission,
    ).toBeNull();
    expect(
      createProfileFixture(
        readProfileOptions(
          new URLSearchParams({ scenario: "historic-approval" }),
        ),
      ).profile.applicationApprovedBy,
    ).toBeNull();
  });

  test("round-trips only the fictional action state without changing the original fixture", () => {
    const options = readProfileOptions(new URLSearchParams());
    const original = createProfileFixture(options);
    const state = {
      ...profileSimulationState(original),
      approved: true,
      patrol: true,
      role: "organizer" as const,
    };
    const parsed = readProfileState(profileStateQuery(options, state));
    expect(parsed).toEqual(state);
    const updated = createProfileFixture(options, parsed);
    expect(updated.person).toMatchObject({
      applicationApproved: 1,
      patrolApproved: 1,
      role: "organizer",
    });
    expect(createProfileFixture(options)).toEqual(original);
    expect(readProfileState(new URLSearchParams())).toBeUndefined();
  });
});
