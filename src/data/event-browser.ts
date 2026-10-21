import type { EventRow, PatrolSeriesRow } from "@/server/db/events";

export function eventFilter(value: string | null, management: boolean) {
  return value === "orientation" ||
    (management && (value === "one-off" || value === "recurring"))
    ? value
    : "all";
}

export function matchesEventFilter(
  filter: string,
  recurring: boolean,
  includesOrientation: boolean,
) {
  return filter === "orientation"
    ? includesOrientation
    : filter === "recurring"
      ? recurring
      : filter === "one-off"
        ? !recurring
        : true;
}

type ManagementItem =
  | { kind: "event"; event: EventRow }
  | { kind: "series"; series: PatrolSeriesRow; events: EventRow[] };

/** Keep the occurrence ordering (including a selected deep link), once per series. */
export function groupManagementEvents(
  events: EventRow[],
  series: PatrolSeriesRow[],
): ManagementItem[] {
  const groups = new Map(
    series.map((item) => [
      item.id,
      { kind: "series" as const, series: item, events: [] as EventRow[] },
    ]),
  );
  const result: ManagementItem[] = [];
  for (const event of events) {
    const group = event.seriesId ? groups.get(event.seriesId) : undefined;
    if (group) {
      if (!group.events.length) result.push(group);
      group.events.push(event);
    } else result.push({ kind: "event", event });
  }
  // Even ended series or those outside the loaded 100 occurrences need tools.
  for (const group of groups.values())
    if (!group.events.length) result.push(group);
  return result;
}
