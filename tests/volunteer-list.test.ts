import { expect, test } from "vitest";
import {
  applicationListUrl,
  applicationListState,
  applicationStatuses,
  directoryListUrl,
  directoryView,
  directoryEmptyMessage,
  type DirectoryPerson,
  volunteerListReturnUrl,
  volunteerListState,
  volunteerListUrl,
} from "../src/data/volunteer-list";

test("application list state preserves approval, search and sorting, dropping obsolete pagination", () => {
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
  expect(applicationListUrl(state)).toBe(
    "/applications?q=Alex+%26+Sam&approval=awaiting&direction=desc",
  );
  expect(applicationListUrl({ ...state, sort: "name", direction: "asc" })).toBe(
    "/applications?q=Alex+%26+Sam&approval=awaiting&sort=name",
  );
  expect(volunteerListReturnUrl("/applications")).toBe("/applications");
  expect(
    volunteerListReturnUrl("/volunteers?q=Alex+%26+Sam&approval=awaiting"),
  ).toBe("/volunteers?q=Alex+%26+Sam");
  const sorted = { ...state, sort: "name", direction: "desc" } as const;
  expect(volunteerListReturnUrl(volunteerListUrl(sorted))).toBe(
    "/volunteers?q=Alex+%26+Sam&sort=name&direction=desc",
  );
  expect(directoryListUrl("applications", sorted)).toBe(
    "/applications?q=Alex+%26+Sam&approval=awaiting&sort=name&direction=desc",
  );
  expect(directoryListUrl("volunteers", state)).toBe(
    "/volunteers?q=Alex+%26+Sam&direction=desc",
  );
  for (const approval of Object.keys(applicationStatuses)) {
    const filtered = applicationListState(
      new URLSearchParams({
        approval,
        q: "Alex & Sam",
        offset: "50",
        sort: "completed",
        direction: "desc",
      }),
    );
    expect(filtered.approval).toBe(approval);
    expect(volunteerListReturnUrl(applicationListUrl(filtered))).toBe(
      `/applications?q=Alex+%26+Sam&approval=${approval}&sort=completed&direction=desc`,
    );
  }
  const volunteers = volunteerListState(new URLSearchParams("sort=role"));
  expect(volunteerListUrl(volunteers)).toBe("/volunteers");
  expect(
    volunteerListState(
      new URL(volunteerListUrl(volunteers), "https://example.org").searchParams,
    ),
  ).toEqual(volunteers);
});

test("list return destinations are restricted and untrusted filter inputs are normalized", () => {
  for (const value of [
    null,
    "https://evil.example/volunteers?q=x",
    "//evil.example",
    "/volunteers/another?q=x",
    "/applications/another?q=x",
    "/applications-other?q=x",
    "/manage/applications?direction=desc",
    "/manage/volunteers?q=Alex",
    "/volunteer/volunteers?q=Alex",
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
      "/applications?sort=progress&direction=desc&offset=50",
    ),
  ).toBe("/applications?direction=desc");
  expect(applicationListState(new URLSearchParams()).sort).toBe("progress");
  for (const approval of ["unknown", "__proto__", "constructor"])
    expect(
      applicationListState(new URLSearchParams({ approval })).approval,
    ).toBe("all");
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
    "role",
  );
  expect(volunteerListState(new URLSearchParams("sort=patrol")).sort).toBe(
    "role",
  );
  expect(
    volunteerListReturnUrl("/volunteers?sort=patrol&direction=desc&offset=50"),
  ).toBe("/volunteers?direction=desc");
  expect(
    volunteerListState(
      new URLSearchParams({ q: "x".repeat(200), offset: "999999" }),
    ),
  ).toEqual({
    search: "x".repeat(100),
    approval: "all",
    sort: "role",
    direction: "asc",
  });
});

const person = (
  id: string,
  overrides: Partial<DirectoryPerson> = {},
): DirectoryPerson => ({
  id,
  name: id,
  searchName: id,
  role: "volunteer",
  category: "new-volunteer",
  medicMark: 0,
  status: "awaiting",
  applicationCompletedAt: 0,
  ...overrides,
});

test("a complete 500-person directory can be searched without slicing or mutating its source", () => {
  const people = Array.from({ length: 500 }, (_, i) =>
    person(String(i).padStart(3, "0")),
  );
  const state = applicationListState(new URLSearchParams());
  expect(directoryView(people, "applications", state).rows).toHaveLength(500);
  expect(
    directoryView(people, "applications", { ...state, search: "499" }).rows,
  ).toEqual([people[499]]);
  expect(
    directoryView(people, "applications", {
      ...state,
      direction: "desc",
      sort: "name",
    }).rows[0],
  ).toBe(people[499]);
  expect(people[0].id).toBe("000");
});

test("full-name searches are literal, ASCII-insensitive and count all statuses before filtering", () => {
  const people = [
    person("alex", {
      name: "Alex d.",
      searchName: "Alex d. Alexander Jordan de la Cruz",
      status: "awaiting",
    }),
    person("approved", { searchName: "alex approved", status: "approved" }),
    person("rejected", { searchName: "alex rejected", status: "rejected" }),
    person("pending", {
      searchName: "alex in progress",
      status: "in-progress",
    }),
  ];
  const state = applicationListState(
    new URLSearchParams("approval=awaiting&q=ALEX"),
  );
  expect(directoryView(people, "applications", state)).toMatchObject({
    rows: [people[0]],
    allApplicantsCount: 4,
    awaitingApprovalCount: 1,
    approvedCount: 1,
    rejectedCount: 1,
    inProgressCount: 1,
  });
  expect(
    directoryView(people, "applications", {
      ...state,
      search: "JORDAN DE LA CRUZ",
    }).rows,
  ).toEqual([people[0]]);
  for (const search of [".*", "%", "_"])
    expect(
      directoryView(people, "applications", { ...state, search }).rows,
    ).toEqual([]);
  expect(
    directoryView([person("Élodie")], "applications", {
      ...state,
      search: "élodie",
    }).rows,
  ).toEqual([]);
});

test("application sorting preserves status precedence, latest completions, null dates and stable name/id ties", () => {
  const people = [
    person("b", { name: "ALPHA", applicationCompletedAt: 1 }),
    person("a", { name: "alpha", applicationCompletedAt: 1 }),
    person("newest", { applicationCompletedAt: 2 }),
    person("pending", { status: "in-progress", applicationCompletedAt: null }),
    person("rejected", { status: "rejected", applicationCompletedAt: 3 }),
    person("approved", { status: "approved", applicationCompletedAt: 4 }),
  ];
  const state = applicationListState(new URLSearchParams());
  const ids = (
    sort: typeof state.sort,
    direction: typeof state.direction = "asc",
  ) =>
    directoryView(people, "applications", {
      ...state,
      sort,
      direction,
    }).rows.map(({ id }) => id);
  expect(ids("progress")).toEqual([
    "newest",
    "a",
    "b",
    "pending",
    "rejected",
    "approved",
  ]);
  expect(ids("progress", "desc")).toEqual([
    "approved",
    "rejected",
    "pending",
    "newest",
    "a",
    "b",
  ]);
  expect(ids("completed")).toEqual([
    "pending",
    "a",
    "b",
    "newest",
    "rejected",
    "approved",
  ]);
  expect(ids("completed", "desc")).toEqual([
    "approved",
    "rejected",
    "newest",
    "a",
    "b",
    "pending",
  ]);
});

test("empty messages describe search and status, never removed pagination", () => {
  const state = applicationListState(new URLSearchParams("approval=awaiting"));
  expect(directoryEmptyMessage("applications", state)).toBe(
    "No applications are ready for review.",
  );
  expect(
    directoryEmptyMessage("applications", { ...state, search: "missing" }),
  ).toBe("No applications ready for review match your search.");
  expect(
    directoryEmptyMessage(
      "volunteers",
      volunteerListState(new URLSearchParams()),
    ),
  ).toBe("No approved volunteers yet.");
});

test("profile return links keep audit log filters and pages", () => {
  const url =
    "/audit-log?user=abc&action=event%3Acancelled&before=%7B%22createdAt%22%3A5%2C%22kind%22%3A%22event%22%2C%22id%22%3A%22x%22%7D";
  expect(volunteerListReturnUrl(url)).toBe(url);
  expect(volunteerListReturnUrl("/audit-log?action=unknown&extra=1")).toBe(
    "/audit-log",
  );
});
