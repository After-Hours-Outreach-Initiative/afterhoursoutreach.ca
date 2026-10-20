import { expect, test } from "vitest";
import {
  volunteerListReturnUrl,
  volunteerListState,
  volunteerListUrl,
} from "../src/data/volunteer-list";

test("organizer list state preserves approval, search and pagination in profile return links", () => {
  const state = volunteerListState(
    new URLSearchParams("approval=awaiting&q=Alex+%26+Sam&offset=50"),
  );
  const url = volunteerListUrl(state);
  expect(volunteerListReturnUrl(url)).toBe(url);
  expect(
    volunteerListState(new URL(url, "https://example.org").searchParams),
  ).toEqual(state);
  expect(volunteerListUrl({ ...state, offset: 0 })).toBe(
    "/volunteer/volunteers?q=Alex+%26+Sam&approval=awaiting",
  );
});

test("list return destinations are restricted and untrusted filter inputs are normalized", () => {
  for (const value of [
    null,
    "https://evil.example/volunteer/volunteers?q=x",
    "//evil.example",
    "/volunteer/volunteers/another?q=x",
    "/volunteer/events",
  ])
    expect(volunteerListReturnUrl(value)).toBe("/volunteer/volunteers");
  expect(
    volunteerListReturnUrl(
      "/volunteer/volunteers?approval=viewed&offset=-50&extra=ignored",
    ),
  ).toBe("/volunteer/volunteers");
  expect(
    volunteerListState(
      new URLSearchParams({ q: "x".repeat(200), offset: "999999" }),
    ),
  ).toEqual({ search: "x".repeat(100), offset: 10000, approval: "all" });
});
