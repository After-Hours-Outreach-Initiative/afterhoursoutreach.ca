import { expect, test } from "vitest";
import { accountGreeting } from "../src/data/account-navigation";
import { siteNavigation } from "../src/data/site";

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

test("site navigation replaces the public Volunteer link with top-level role-aware pages", () => {
  expect(siteNavigation(false).map((link) => link.href)).toEqual([
    "/volunteer",
    "/donate",
    "/about",
  ]);
  expect(siteNavigation(true).map((link) => link.href)).toEqual([
    "/events",
    "/donate",
    "/about",
  ]);
  expect(siteNavigation(true, true).map((link) => link.href)).toEqual([
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
