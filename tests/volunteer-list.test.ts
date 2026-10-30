import { expect, test } from "vitest";
import {
  applicationListUrl,
  volunteerListReturnUrl,
  volunteerListState,
  volunteerListUrl,
} from "../src/data/volunteer-list";

test("application list state preserves approval, search and pagination in profile return links", () => {
  const state = volunteerListState(
    new URLSearchParams("approval=awaiting&q=Alex+%26+Sam&offset=50"),
  );
  const url = applicationListUrl(state);
  expect(volunteerListReturnUrl(url)).toBe(url);
  expect(
    volunteerListState(new URL(url, "https://example.org").searchParams),
  ).toEqual(state);
  expect(applicationListUrl({ ...state, offset: 0 })).toBe(
    "/applications?q=Alex+%26+Sam&approval=awaiting",
  );
  expect(volunteerListUrl(state)).toBe("/volunteers?q=Alex+%26+Sam&offset=50");
  expect(volunteerListReturnUrl("/manage/applications")).toBe("/applications");
  expect(
    volunteerListReturnUrl(
      "/volunteer/volunteers?q=Alex+%26+Sam&approval=awaiting",
    ),
  ).toBe(volunteerListUrl({ ...state, offset: 0 }));
  const sorted = { ...state, sort: "patrol", direction: "desc" } as const;
  expect(volunteerListReturnUrl(volunteerListUrl(sorted))).toBe(
    "/volunteers?q=Alex+%26+Sam&sort=patrol&direction=desc&offset=50",
  );
  expect(applicationListUrl(sorted)).toBe(url);
});

test("list return destinations are restricted and untrusted filter inputs are normalized", () => {
  for (const value of [
    null,
    "https://evil.example/volunteers?q=x",
    "//evil.example",
    "/volunteers/another?q=x",
    "/manage/applications/another?q=x",
    "/manage/applications-other?q=x",
    "/volunteer/events",
  ])
    expect(volunteerListReturnUrl(value)).toBe("/volunteers");
  expect(
    volunteerListReturnUrl(
      "/volunteers?approval=viewed&offset=-50&extra=ignored&sort=unknown&direction=unknown",
    ),
  ).toBe("/volunteers");
  expect(
    volunteerListState(
      new URLSearchParams({ q: "x".repeat(200), offset: "999999" }),
    ),
  ).toEqual({
    search: "x".repeat(100),
    offset: 10000,
    approval: "all",
    sort: "name",
    direction: "asc",
  });
});
