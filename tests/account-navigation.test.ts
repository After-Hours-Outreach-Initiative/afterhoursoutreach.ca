import { expect, test } from "vitest";
import { accountGreeting } from "../src/data/account-navigation";

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
