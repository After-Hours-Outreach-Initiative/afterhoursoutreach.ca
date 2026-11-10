import type { AttendeeCategory } from "./event-roster";

export type VolunteerApprovalFilter = "all" | "awaiting";
// Preserve the existing review-queue URL while sharing the table's exact labels.
export const applicationStatuses = {
  awaiting: { label: "Ready for review", state: "ready" },
  "in-progress": { label: "In Progress", state: "in-progress" },
  rejected: { label: "Rejected", state: "rejected" },
  approved: { label: "Approved", state: "approved" },
} as const;
export type ApplicationStatus = keyof typeof applicationStatuses;
export type ApplicationApprovalFilter = "all" | ApplicationStatus;

/** Match the status column's precedence, including legacy approvals. */
export function applicationStatus(person: {
  applicationApproved: number | boolean;
  applicationRejectionReason: string | null;
  applicationReadyForReview: number | boolean;
}): ApplicationStatus {
  return person.applicationApproved
    ? "approved"
    : person.applicationRejectionReason
      ? "rejected"
      : person.applicationReadyForReview
        ? "awaiting"
        : "in-progress";
}

function applicationApprovalFilter(
  value: string | null,
): ApplicationApprovalFilter {
  return value && Object.hasOwn(applicationStatuses, value)
    ? (value as ApplicationStatus)
    : "all";
}

export type VolunteerSort = "name" | "role";
export type ApplicationSort = "name" | "role" | "progress" | "completed";
export type DirectoryKind = "applications" | "volunteers";
export type DirectorySort = VolunteerSort | ApplicationSort;
export type VolunteerSortDirection = "asc" | "desc";

/** Only directory/search fields are sent to the browser, never profile answers. */
export interface DirectoryPerson {
  id: string;
  name: string;
  searchName: string;
  role: "volunteer" | "organizer";
  category: AttendeeCategory;
  medicMark: number;
  status: ApplicationStatus;
  applicationCompletedAt: number | null;
}

// Preserve SQLite's ASCII-only lower()/NOCASE behavior in both renderers.
const fold = (value: string) =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const compare = (a: string | number, b: string | number) =>
  a < b ? -1 : a > b ? 1 : 0;

export function directoryView<T extends DirectoryPerson>(
  people: readonly T[],
  kind: DirectoryKind,
  state: DirectoryListState,
) {
  const applications = kind === "applications";
  const query = fold(state.search.slice(0, 100));
  const matching = people.filter((person) =>
    fold(person.searchName).includes(query),
  );
  const count = (status: ApplicationStatus) =>
    matching.filter((person) => person.status === status).length;
  const progress = { awaiting: 0, "in-progress": 1, rejected: 2, approved: 3 };
  const primary = (person: T) => {
    if (applications && state.sort === "progress")
      return progress[person.status];
    if (applications && state.sort === "completed")
      return person.applicationCompletedAt ?? -Infinity;
    if (state.sort === "role")
      return applications
        ? person.medicMark
          ? "medic"
          : ""
        : person.role === "organizer"
          ? "organizer"
          : person.category === "new-volunteer"
            ? "new"
            : person.category === "medic"
              ? "medic"
              : "";
    return fold(person.name);
  };
  const rows = matching
    .filter(
      (person) =>
        !applications ||
        state.approval === "all" ||
        person.status === state.approval,
    )
    .sort(
      (a, b) =>
        compare(primary(a), primary(b)) *
          (state.direction === "desc" ? -1 : 1) ||
        (applications && state.sort === "progress"
          ? compare(
              b.applicationCompletedAt ?? -Infinity,
              a.applicationCompletedAt ?? -Infinity,
            )
          : 0) ||
        compare(fold(a.name), fold(b.name)) ||
        compare(a.id, b.id),
    );
  return {
    rows,
    allApplicantsCount: matching.length,
    awaitingApprovalCount: count("awaiting"),
    inProgressCount: count("in-progress"),
    rejectedCount: count("rejected"),
    approvedCount: count("approved"),
  };
}

export function directoryEmptyMessage(
  kind: DirectoryKind,
  state: DirectoryListState,
) {
  if (kind === "volunteers")
    return state.search
      ? "No volunteers match your search."
      : "No approved volunteers yet.";
  const subject = {
    all: "applications",
    awaiting: "applications ready for review",
    "in-progress": "applications in progress",
    rejected: "rejected applications",
    approved: "approved applications",
  }[state.approval];
  return state.search
    ? `No ${subject} match your search.`
    : state.approval === "awaiting"
      ? "No applications are ready for review."
      : state.approval === "all"
        ? "No applications to review."
        : `No ${subject}.`;
}

export function volunteerListState(params: URLSearchParams) {
  return { ...listState(params), sort: volunteerSort(params.get("sort")) };
}

export function applicationListState(params: URLSearchParams) {
  return {
    ...listState(params),
    approval: applicationApprovalFilter(params.get("approval")),
    sort: applicationSort(params.get("sort")),
  };
}

export type DirectoryListState =
  | ReturnType<typeof volunteerListState>
  | ReturnType<typeof applicationListState>;

export function directoryListState(
  params: URLSearchParams,
  kind: DirectoryKind,
) {
  return kind === "applications"
    ? applicationListState(params)
    : volunteerListState(params);
}

function volunteerSort(value: string | null): VolunteerSort {
  return value === "name" ? value : "role";
}

function applicationSort(value: string | null): ApplicationSort {
  return value === "name" || value === "role" || value === "completed"
    ? value
    : "progress";
}

function listState(params: URLSearchParams) {
  return {
    search: (params.get("q") ?? "").slice(0, 100),
    approval: params.get("approval") === "awaiting" ? "awaiting" : "all",
    direction: params.get("direction") === "desc" ? "desc" : "asc",
  } satisfies {
    search: string;
    approval: VolunteerApprovalFilter;
    direction: VolunteerSortDirection;
  };
}

export function volunteerListUrl(state: DirectoryListState) {
  return directoryListUrl("volunteers", state);
}

export function applicationListUrl(
  state: ReturnType<typeof applicationListState>,
) {
  return directoryListUrl("applications", state);
}

/** Shared views normalize sort keys to the destination directory's columns. */
export function directoryListUrl(
  kind: DirectoryKind,
  state: DirectoryListState,
) {
  const applications = kind === "applications";
  const sort = applications
    ? applicationSort(state.sort)
    : volunteerSort(state.sort);
  const params = new URLSearchParams();
  if (state.search) params.set("q", state.search);
  if (applications && state.approval !== "all")
    params.set("approval", state.approval);
  if (sort !== (applications ? "progress" : "role")) params.set("sort", sort);
  if (state.direction !== "asc") params.set("direction", state.direction);
  const query = params.toString();
  return `/${applications ? "applications" : "volunteers"}${query ? `?${query}` : ""}`;
}

/** Only return to organizer lists, never a supplied external destination. */
export function volunteerListReturnUrl(value: string | null) {
  if (!value || !/^\/(?:applications|volunteers)(?:\?|$)/.test(value))
    return "/volunteers";
  const params = new URLSearchParams(value.split("?")[1]);
  return /^\/applications(?:\?|$)/.test(value)
    ? applicationListUrl(applicationListState(params))
    : volunteerListUrl(volunteerListState(params));
}
