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
    "/about",
    "/volunteer",
    "/donate",
  ]);
  expect(siteNavigation(true).map((link) => link.href)).toEqual([
    "/about",
    "/events",
    "/donate",
  ]);
  expect(siteNavigation(true, true).map((link) => link.href)).toEqual([
    "/about",
    "/events",
    "/volunteers",
    "/donate",
  ]);
});
