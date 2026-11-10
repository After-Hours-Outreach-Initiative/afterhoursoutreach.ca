import type { AttendeeCategory } from "./event-roster";
import { auditCursor, auditFilters, auditLogUrl } from "./audit-log";

// Preserve the existing review-queue URL while sharing the table's exact labels.
export const applicationStatuses = {
  awaiting: { label: "Ready for review", state: "ready" },
  "in-progress": { label: "In Progress", state: "in-progress" },
  rejected: { label: "Rejected", state: "rejected" },
  approved: { label: "Approved", state: "approved" },
} as const;
export type ApplicationStatus = keyof typeof applicationStatuses;
/** A single status, or "all", for callers that filter by one status. */
export type ApplicationApprovalFilter = "all" | ApplicationStatus;

/** Directory roles, in their default sort order. */
export const directoryRoles = {
  organizer: "Organizer",
  medic: "Medic",
  new: "New volunteer",
  volunteer: "Outreach Volunteer",
} as const;
export type DirectoryRole = keyof typeof directoryRoles;

/** Applicants only differ by medic team interest, not account roles. */
export function directoryRoleKeys(kind: DirectoryKind): DirectoryRole[] {
  return kind === "applications"
    ? ["medic", "volunteer"]
    : ["organizer", "medic", "new", "volunteer"];
}

export function directoryRole(
  person: Pick<DirectoryPerson, "role" | "category" | "medicMark">,
  kind: DirectoryKind,
): DirectoryRole {
  if (kind === "applications") return person.medicMark ? "medic" : "volunteer";
  return person.role === "organizer"
    ? "organizer"
    : person.category === "new-volunteer"
      ? "new"
      : person.category === "medic"
        ? "medic"
        : "volunteer";
}

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

/** Known statuses in display order; unknown or "all" values select none. */
function applicationApprovalFilter(values: string[]): ApplicationStatus[] {
  return (Object.keys(applicationStatuses) as ApplicationStatus[]).filter(
    (status) => values.includes(status),
  );
}

function roleFilter(values: string[], kind: DirectoryKind) {
  return directoryRoleKeys(kind).filter((role) => values.includes(role));
}

/** A complete permutation of the directory's roles, or the default order. */
function roleOrder(value: string | null, kind: DirectoryKind) {
  const keys = directoryRoleKeys(kind);
  const order = (value ?? "")
    .split(",")
    .filter(
      (role, index, all) =>
        keys.includes(role as DirectoryRole) && all.indexOf(role) === index,
    ) as DirectoryRole[];
  return order.length === keys.length ? order : keys;
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
  const searched = people.filter((person) =>
    fold(person.searchName).includes(query),
  );
  const roleOf = (person: T) => directoryRole(person, kind);
  const statusMatches = (person: T) =>
    !applications ||
    !state.approval.length ||
    state.approval.includes(person.status);
  const roleMatches = (person: T) =>
    !state.roles.length || state.roles.includes(roleOf(person));
  // Each filter's counts reflect the search and the other filter.
  const matching = searched.filter(roleMatches);
  const count = (status: ApplicationStatus) =>
    matching.filter((person) => person.status === status).length;
  const roleCounts = Object.fromEntries(
    directoryRoleKeys(kind).map((role) => [
      role,
      searched.filter(
        (person) => statusMatches(person) && roleOf(person) === role,
      ).length,
    ]),
  ) as Partial<Record<DirectoryRole, number>>;
  const progress = { awaiting: 0, "in-progress": 1, rejected: 2, approved: 3 };
  const primary = (person: T) => {
    if (applications && state.sort === "progress")
      return progress[person.status];
    if (applications && state.sort === "completed")
      return person.applicationCompletedAt ?? -Infinity;
    if (state.sort === "role") return state.roleOrder.indexOf(roleOf(person));
    return fold(person.name);
  };
  const rows = matching
    .filter(statusMatches)
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
    roleCounts,
  };
}

export function directoryEmptyMessage(
  kind: DirectoryKind,
  state: DirectoryListState,
) {
  // A single status keeps its specific wording, such as the review queue.
  const status =
    kind === "applications" &&
    !state.roles.length &&
    state.approval.length === 1
      ? state.approval[0]
      : undefined;
  if (status) {
    const subject = {
      awaiting: "applications ready for review",
      "in-progress": "applications in progress",
      rejected: "rejected applications",
      approved: "approved applications",
    }[status];
    return state.search
      ? `No ${subject} match your search.`
      : status === "awaiting"
        ? "No applications are ready for review."
        : `No ${subject}.`;
  }
  const noun = kind === "volunteers" ? "volunteers" : "applications";
  const filtered = state.roles.length + state.approval.length > 0;
  if (state.search || filtered)
    return `No ${noun} match ${
      state.search && filtered
        ? "your search and filters"
        : state.search
          ? "your search"
          : "these filters"
    }.`;
  return kind === "volunteers"
    ? "No approved volunteers yet."
    : "No applications to review.";
}

export function volunteerListState(params: URLSearchParams) {
  return {
    ...listState(params, "volunteers"),
    sort: volunteerSort(params.get("sort")),
  };
}

export function applicationListState(params: URLSearchParams) {
  return {
    ...listState(params, "applications"),
    approval: applicationApprovalFilter(params.getAll("approval")),
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

function listState(params: URLSearchParams, kind: DirectoryKind) {
  return {
    search: (params.get("q") ?? "").slice(0, 100),
    // Volunteers have no application status filter.
    approval: [] as ApplicationStatus[],
    roles: roleFilter(params.getAll("role"), kind),
    roleOrder: roleOrder(params.get("order"), kind),
    direction: (params.get("direction") === "desc"
      ? "desc"
      : "asc") as VolunteerSortDirection,
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
  if (applications)
    for (const status of applicationApprovalFilter(state.approval))
      params.append("approval", status);
  for (const role of roleFilter(state.roles, kind)) params.append("role", role);
  if (sort !== (applications ? "progress" : "role")) params.set("sort", sort);
  if (state.direction !== "asc") params.set("direction", state.direction);
  const order = roleOrder(state.roleOrder.join(","), kind);
  if (order.join(",") !== directoryRoleKeys(kind).join(","))
    params.set("order", order.join(","));
  const query = params.toString();
  return `/${applications ? "applications" : "volunteers"}${query ? `?${query}` : ""}`;
}

/** Only return to organizer lists, never a supplied external destination. */
export function volunteerListReturnUrl(value: string | null) {
  if (value && /^\/audit-log(?:\?|$)/.test(value)) {
    const params = new URLSearchParams(value.split("?")[1]);
    return auditLogUrl(auditFilters(params), auditCursor(params.get("before")));
  }
  if (!value || !/^\/(?:applications|volunteers)(?:\?|$)/.test(value))
    return "/volunteers";
  const params = new URLSearchParams(value.split("?")[1]);
  return /^\/applications(?:\?|$)/.test(value)
    ? applicationListUrl(applicationListState(params))
    : volunteerListUrl(volunteerListState(params));
}
