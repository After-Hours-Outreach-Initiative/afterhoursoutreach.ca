export type VolunteerApprovalFilter = "all" | "awaiting";
export type VolunteerSort = "name" | "role" | "patrol";
export type ApplicationSort = "name" | "role" | "progress" | "completed";
export type DirectoryKind = "applications" | "volunteers";
export type DirectorySort = VolunteerSort | ApplicationSort;
export type VolunteerSortDirection = "asc" | "desc";
export const volunteerPageSize = 50;

export function volunteerListState(params: URLSearchParams) {
  return { ...listState(params), sort: volunteerSort(params.get("sort")) };
}

export function applicationListState(params: URLSearchParams) {
  return { ...listState(params), sort: applicationSort(params.get("sort")) };
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
  return value === "role" || value === "patrol" ? value : "name";
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
    offset: Math.min(
      10000,
      Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0),
    ),
  } satisfies {
    search: string;
    approval: VolunteerApprovalFilter;
    direction: VolunteerSortDirection;
    offset: number;
  };
}

export function volunteerListUrl(state: ReturnType<typeof volunteerListState>) {
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
  if (applications && state.approval === "awaiting")
    params.set("approval", state.approval);
  if (sort !== (applications ? "progress" : "name")) params.set("sort", sort);
  if (state.direction !== "asc") params.set("direction", state.direction);
  if (state.offset) params.set("offset", String(state.offset));
  const query = params.toString();
  return `/${applications ? "applications" : "volunteers"}${query ? `?${query}` : ""}`;
}

/** Only return to organizer lists, never a supplied external destination. */
export function volunteerListReturnUrl(value: string | null) {
  if (
    !value ||
    !/^\/(?:(?:manage\/)?applications|(?:(?:manage|volunteer)\/)?volunteers)(?:\?|$)/.test(
      value,
    )
  )
    return "/volunteers";
  const params = new URLSearchParams(value.split("?")[1]);
  return /^\/(?:manage\/)?applications(?:\?|$)/.test(value)
    ? applicationListUrl(applicationListState(params))
    : volunteerListUrl(volunteerListState(params));
}
