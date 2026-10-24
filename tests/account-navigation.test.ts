import { expect, test } from "vitest";
import { accountGreeting } from "../src/data/account-navigation";
import { contactEmail, siteNavigation } from "../src/data/site";
import {
  canViewEvents,
  requireVolunteer,
  type Actor,
} from "../src/server/db/access";
import { isApplicationComplete } from "../src/server/db/application-progress";

test("account greeting preserves preferred names and falls back to the first name", () => {
  expect(accountGreeting({ firstName: "Alex", preferredName: "  AJ  " })).toBe(
    "AJ",
  );
  expect(
    accountGreeting({ firstName: "Mary", preferredName: "Mary Jane" }),
  ).toBe("Mary Jane");
  expect(accountGreeting({ firstName: "  Taylor  ", preferredName: " " })).toBe(
    "Taylor",
  );
  expect(accountGreeting(undefined, "Jamie Park")).toBe("Jamie");
  expect(accountGreeting()).toBe("Account");
});

test("site navigation keeps Volunteer until event access is available", () => {
  expect(siteNavigation(false).map((link) => link.href)).toEqual([
    "/volunteer",
    "/donate",
    "/about",
  ]);
  expect(siteNavigation(true)[0]).toEqual({
    label: "Volunteer",
    href: "/volunteer",
  });
  expect(siteNavigation(true, false, true)[0]).toEqual({
    label: "Events",
    href: "/events",
  });
  expect(siteNavigation(true, false, true).map((link) => link.href)).toEqual([
    "/events",
    "/donate",
    "/about",
  ]);
  expect(siteNavigation(true, true, true).map((link) => link.href)).toEqual([
    "/events",
    "/manage/events",
    "/donate",
    "/about",
  ]);
  expect(siteNavigation(true, true)[1]).toMatchObject({
    label: "Manage",
    children: [
      { label: "Events", href: "/manage/events" },
      { label: "Volunteers", href: "/manage/volunteers" },
    ],
  });
});

test("event access uses all three application milestones, not orientation attendance", () => {
  const actor: Actor = {
    id: "applicant",
    name: "Applicant",
    sessionId: "session",
    role: "volunteer",
    applicationSubmitted: true,
    applicationApproved: true,
    applicationComplete: true,
    naloxoneCompleted: true,
    active: true,
    patrolApproved: false,
    twoFactorEnabled: false,
    twoFactorVerified: false,
  };
  for (const progress of [
    { submittedAt: null, naloxoneCompletedAt: 0, applicationApproved: true },
    { submittedAt: 0, naloxoneCompletedAt: null, applicationApproved: true },
    { submittedAt: 0, naloxoneCompletedAt: 0, applicationApproved: false },
    { submittedAt: 0, naloxoneCompletedAt: 0, applicationApproved: true },
  ]) {
    const current = {
      ...actor,
      applicationSubmitted: progress.submittedAt !== null,
      applicationApproved: progress.applicationApproved,
      applicationComplete: isApplicationComplete(progress),
    };
    expect(canViewEvents(current)).toBe(current.applicationComplete);
    expect(siteNavigation(true, false, canViewEvents(current))[0].label).toBe(
      current.applicationComplete ? "Events" : "Volunteer",
    );
    if (current.applicationComplete)
      expect(() => requireVolunteer(current)).not.toThrow();
    else expect(() => requireVolunteer(current)).toThrow();
  }
  expect(canViewEvents(null)).toBe(false);
  expect(canViewEvents({ ...actor, active: false })).toBe(false);
  expect(() => requireVolunteer({ ...actor, active: false })).toThrow(
    `Your volunteer account is inactive. Contact an organizer at ${contactEmail} to restore access.`,
  );
  expect(canViewEvents({ ...actor, twoFactorEnabled: true })).toBe(false);
  expect(
    canViewEvents({
      ...actor,
      applicationComplete: false,
      patrolApproved: true,
    }),
  ).toBe(true);
  expect(
    canViewEvents({
      ...actor,
      applicationComplete: false,
      applicationApproved: false,
      role: "organizer",
    }),
  ).toBe(true);
});
