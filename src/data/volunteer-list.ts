export type VolunteerApprovalFilter = "all" | "awaiting";
export type VolunteerSort = "name" | "role" | "patrol";
export type VolunteerSortDirection = "asc" | "desc";
export const volunteerPageSize = 50;

export function volunteerListState(params: URLSearchParams) {
  const sort = params.get("sort");
  return {
    search: (params.get("q") ?? "").slice(0, 100),
    approval: params.get("approval") === "awaiting" ? "awaiting" : "all",
    sort: sort === "role" || sort === "patrol" ? sort : "name",
    direction: params.get("direction") === "desc" ? "desc" : "asc",
    offset: Math.min(
      10000,
      Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0),
    ),
  } satisfies {
    search: string;
    approval: VolunteerApprovalFilter;
    sort: VolunteerSort;
    direction: VolunteerSortDirection;
    offset: number;
  };
}

export function volunteerListUrl(state: ReturnType<typeof volunteerListState>) {
  return listUrl(state, false);
}

export function applicationListUrl(
  state: ReturnType<typeof volunteerListState>,
) {
  return listUrl(state, true);
}

function listUrl(
  state: ReturnType<typeof volunteerListState>,
  applications: boolean,
) {
  const params = new URLSearchParams();
  if (state.search) params.set("q", state.search);
  if (applications && state.approval === "awaiting")
    params.set("approval", state.approval);
  if (!applications) {
    if (state.sort !== "name") params.set("sort", state.sort);
    if (state.direction !== "asc") params.set("direction", state.direction);
  }
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
  const url = /^\/(?:manage\/)?applications(?:\?|$)/.test(value)
    ? applicationListUrl
    : volunteerListUrl;
  return url(volunteerListState(new URLSearchParams(value.split("?")[1])));
}
