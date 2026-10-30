import { expect, test } from "vitest";
import {
  applicationListUrl,
  applicationListState,
  directoryListUrl,
  volunteerListReturnUrl,
  volunteerListState,
  volunteerListUrl,
} from "../src/data/volunteer-list";

test("application list state preserves approval, search, sorting and pagination in profile return links", () => {
  const state = applicationListState(
    new URLSearchParams(
      "approval=awaiting&q=Alex+%26+Sam&sort=progress&direction=desc&offset=50",
    ),
  );
  const url = applicationListUrl(state);
  expect(volunteerListReturnUrl(url)).toBe(url);
  expect(
    applicationListState(new URL(url, "https://example.org").searchParams),
  ).toEqual(state);
  expect(applicationListUrl({ ...state, offset: 0 })).toBe(
    "/applications?q=Alex+%26+Sam&approval=awaiting&direction=desc",
  );
  expect(applicationListUrl({ ...state, sort: "name", direction: "asc" })).toBe(
    "/applications?q=Alex+%26+Sam&approval=awaiting&sort=name&offset=50",
  );
  expect(volunteerListReturnUrl("/manage/applications")).toBe("/applications");
  expect(
    volunteerListReturnUrl(
      "/volunteer/volunteers?q=Alex+%26+Sam&approval=awaiting",
    ),
  ).toBe("/volunteers?q=Alex+%26+Sam");
  const sorted = { ...state, sort: "patrol", direction: "desc" } as const;
  expect(volunteerListReturnUrl(volunteerListUrl(sorted))).toBe(
    "/volunteers?q=Alex+%26+Sam&sort=patrol&direction=desc&offset=50",
  );
  expect(directoryListUrl("applications", sorted)).toBe(
    "/applications?q=Alex+%26+Sam&approval=awaiting&direction=desc&offset=50",
  );
  expect(directoryListUrl("volunteers", state)).toBe(
    "/volunteers?q=Alex+%26+Sam&direction=desc&offset=50",
  );
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
    volunteerListReturnUrl(
      "/manage/applications?sort=progress&direction=desc&offset=50",
    ),
  ).toBe("/applications?direction=desc&offset=50");
  expect(applicationListState(new URLSearchParams()).sort).toBe("progress");
  expect(applicationListState(new URLSearchParams("sort=role")).sort).toBe(
    "role",
  );
  expect(applicationListState(new URLSearchParams("sort=completed")).sort).toBe(
    "completed",
  );
  expect(applicationListState(new URLSearchParams("sort=patrol")).sort).toBe(
    "progress",
  );
  expect(volunteerListState(new URLSearchParams("sort=progress")).sort).toBe(
    "name",
  );
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
