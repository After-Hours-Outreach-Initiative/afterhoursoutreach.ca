import type { ComponentProps } from "astro/types";
import type VolunteerDirectory from "../../components/volunteer/VolunteerDirectory.astro";
import {
  volunteerListState,
  volunteerPageSize,
} from "../../data/volunteer-list";

export type TableKind = "applications" | "volunteers";
type DirectoryPeople = ComponentProps<typeof VolunteerDirectory>["people"];
type Person = DirectoryPeople["rows"][number];

export const tableChannel = "ahoi-local-ui-table";
export const tableWidths = [
  "fit",
  "1440",
  "1024",
  "768",
  "375",
  "320",
] as const;
export const tableOutcomes = ["success", "failure", "pending"] as const;

export function tableKind(path: string): TableKind {
  return path.startsWith("/dev/ui/applications")
    ? "applications"
    : "volunteers";
}

export function tableScenarios(kind: TableKind) {
  return [
    {
      id: "mixed",
      label: "Representative rows",
      description:
        kind === "applications"
          ? "Submitted applications in progress, ready for review, and rejected. Unsubmitted drafts stay private."
          : "Organizers, medics, outreach volunteers, and new volunteers, with both patrol access states and medic marks.",
    },
    {
      id: "long-names",
      label: "Long names",
      description:
        "Long, hyphenated, and unbroken names for checking wrapping and horizontal scrolling at narrow widths.",
    },
    {
      id: "paginated",
      label: "Multiple pages",
      description: `63 fictional people, using the real ${volunteerPageSize}-row page size. Search and volunteer sorting happen before pagination.`,
    },
    {
      id: "empty",
      label: "Empty directory",
      description:
        "No submitted applications or approved volunteers. Search also exposes the no-matches message.",
    },
    ...(kind === "applications"
      ? [
          {
            id: "none-ready",
            label: "None ready for review",
            description:
              "Applications exist, but none are ready. Switch approval filters to inspect the empty review queue.",
          },
        ]
      : []),
  ];
}

export function readTableOptions(kind: TableKind, params: URLSearchParams) {
  const latency = Number(params.get("latency") ?? 400);
  return {
    scenario:
      tableScenarios(kind).find(({ id }) => id === params.get("scenario"))
        ?.id ?? "mixed",
    width: tableWidths.find((value) => value === params.get("width")) ?? "fit",
    outcome:
      tableOutcomes.find((value) => value === params.get("outcome")) ??
      "success",
    latency: Number.isFinite(latency)
      ? Math.min(5000, Math.max(0, Math.round(latency)))
      : 400,
  };
}

export type TableOptions = ReturnType<typeof readTableOptions>;

export function tableQuery(options: TableOptions) {
  return new URLSearchParams(
    Object.entries(options).map(([key, value]) => [key, String(value)]),
  );
}

export function tablePreviewUrl(
  kind: TableKind,
  options: TableOptions,
  state = volunteerListState(new URLSearchParams()),
) {
  const query = tableQuery(options);
  if (state.search) query.set("q", state.search);
  if (state.offset) query.set("offset", String(state.offset));
  if (kind === "applications") query.set("approval", state.approval);
  else {
    query.set("sort", state.sort);
    query.set("direction", state.direction);
  }
  return `/dev/ui/${kind}/preview?${query}`;
}

const names = [
  "Alex Rivera",
  "Avery Chen",
  "Casey O’Neill",
  "Jordan Singh",
  "Morgan Park",
  "Riley Ahmed",
  "Sam Williams",
  "Taylor Nguyen",
];
const longNames = [
  "Alexandria Jordan Rivera-Montgomery (Alex)",
  "Avery-James Chen-Williams de la Cruz",
  "CaseyWithAnUnusuallyLongUnbrokenFictionalPreferredName",
  "Jordan Amara Singh-Robertson",
  "Morgan Élodie Park-Lefèvre",
  "Riley Samira Ahmed-Montgomery",
  "Sam Jacqueline Williams-Rivera",
  "Taylor Minh-Anh Nguyen-Chen",
];
const applicationProfiles = [
  "naloxone-pending",
  "ready-for-review",
  "rejected",
];
const volunteerProfiles = [
  "organizer",
  "medic",
  "outreach-volunteer",
  "accepted",
  "medic-new-volunteer",
  "orientation-completed",
  "legacy-patrol",
  "inactive",
];

function roleLabel(person: Person) {
  return person.role === "organizer"
    ? "Organizer"
    : person.category === "new-volunteer"
      ? "New volunteer"
      : person.category === "medic"
        ? "Medic"
        : "Outreach Volunteer";
}

// SQLite's NOCASE collation folds ASCII only; match its directory sort and ties.
function compare(a: string | number, b: string | number) {
  const fold = (value: string | number) =>
    typeof value === "string"
      ? value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
      : value;
  const left = fold(a);
  const right = fold(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createTableFixture(
  kind: TableKind,
  options: TableOptions,
  state: ReturnType<typeof volunteerListState>,
) {
  if (!import.meta.env.DEV)
    throw new Error("UI fixtures are local-development only.");
  const applications = kind === "applications";
  const profiles = new Map<string, string>();
  const count =
    options.scenario === "empty"
      ? 0
      : options.scenario === "paginated"
        ? 63
        : names.length;
  const rows: Person[] = Array.from({ length: count }, (_, index) => {
    const variant = index % names.length;
    const id = `ui-${kind}-${index}`;
    const profile = applications
      ? applicationProfiles[index % applicationProfiles.length]!
      : volunteerProfiles[variant]!;
    profiles.set(
      id,
      options.scenario === "none-ready" && profile === "ready-for-review"
        ? "naloxone-pending"
        : profile,
    );
    const ready =
      applications &&
      profile === "ready-for-review" &&
      options.scenario !== "none-ready";
    const name = (options.scenario === "long-names" ? longNames : names)[
      variant
    ]!;
    return {
      id,
      name:
        options.scenario === "paginated"
          ? `${name} · sample ${String(index + 1).padStart(2, "0")}`
          : name,
      role: !applications && variant === 0 ? "organizer" : "volunteer",
      category:
        applications || [3, 4, 5].includes(variant)
          ? "new-volunteer"
          : [1, 6].includes(variant)
            ? "medic"
            : "outreach-volunteer",
      medicMark: Number(!applications && [1, 4, 6].includes(variant)),
      active: Number(variant !== 7),
      applicationApproved: Number(!applications),
      applicationReadyForReview: Number(!applications || ready),
      applicationRejectionReason:
        applications && profile === "rejected"
          ? "Fictional application review decision."
          : null,
      patrolApproved: Number(
        !applications && [0, 1, 2, 6, 7].includes(variant),
      ),
      updatedAt: Date.UTC(2026, 9, 1),
      twoFactorEnabled: Number(!applications && variant === 0),
      orientations: Number(!applications && [0, 1, 2, 5, 7].includes(variant)),
    };
  });
  const matching = rows.filter((person) =>
    compareSearch(person.name, state.search),
  );
  const awaiting = matching.filter(
    (person) =>
      person.applicationReadyForReview && !person.applicationRejectionReason,
  );
  const filtered =
    applications && state.approval === "awaiting" ? awaiting : matching;
  filtered.sort((a, b) => {
    if (applications)
      return (
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || compare(a.id, b.id)
      );
    const primary = (person: Person) =>
      state.sort === "role"
        ? roleLabel(person)
        : state.sort === "patrol"
          ? person.patrolApproved
          : person.name;
    return (
      compare(primary(a), primary(b)) * (state.direction === "desc" ? -1 : 1) ||
      compare(a.name, b.name) ||
      compare(a.id, b.id)
    );
  });
  const people: DirectoryPeople = {
    rows: filtered.slice(state.offset, state.offset + volunteerPageSize),
    hasMore: filtered.length > state.offset + volunteerPageSize,
    allApplicantsCount: matching.length,
    awaitingApprovalCount: awaiting.length,
  };
  return { people, profiles };
}

function compareSearch(name: string, search: string) {
  const fold = (text: string) =>
    text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return fold(name).includes(fold(search));
}
