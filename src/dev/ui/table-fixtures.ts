import type { ComponentProps } from "astro/types";
import type VolunteerDirectory from "../../components/volunteer/VolunteerDirectory.astro";
import { personDisplayName } from "../../data/person-name";
import {
  directoryListState,
  directoryListUrl,
  volunteerPageSize,
  type DirectoryListState,
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
          ? "Medic and outreach applications in progress, ready for review, and rejected. Unsubmitted drafts stay private."
          : "Organizers, medics, outreach volunteers, and new volunteers, with medic marks.",
    },
    {
      id: "long-names",
      label: "Long names",
      description:
        "Long, hyphenated, and unbroken names for checking horizontal table scrolling without wrapping or page overflow.",
    },
    {
      id: "paginated",
      label: "Multiple pages",
      description: `63 fictional people, using the real ${volunteerPageSize}-row page size. Search, filtering, and sorting happen before pagination.`,
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
  state = directoryListState(new URLSearchParams(), kind),
) {
  const query = tableQuery(options);
  const listQuery = new URLSearchParams(
    directoryListUrl(kind, state).split("?")[1],
  );
  listQuery.forEach((value, name) => query.set(name, value));
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
const longPreferredNames = [
  "Alexandria Jordan Marie Jacqueline",
  "Avery-James Dominique",
  "CaseyWithAnUnusuallyLongUnbrokenFictionalPreferredName",
  "Jordan Amara",
  "Morgan Élodie",
  "Riley Samira",
  "Sam Jacqueline",
  "Taylor Minh-Anh",
];
const applicationProfiles = [
  "naloxone-pending",
  "ready-for-review",
  "rejected",
  "medic-applicant",
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
      ? "New"
      : person.category === "medic"
        ? "Medic"
        : "";
}

function progressOrder(person: Person) {
  return person.applicationRejectionReason
    ? 2
    : person.applicationReadyForReview
      ? 0
      : 1;
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
  state: DirectoryListState,
) {
  if (!import.meta.env.DEV)
    throw new Error("UI fixtures are local-development only.");
  const applications = kind === "applications";
  const profiles = new Map<string, string>();
  const searchNames = new Map<string, string>();
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
      options.scenario === "none-ready" &&
        ["ready-for-review", "medic-applicant"].includes(profile)
        ? "naloxone-pending"
        : profile,
    );
    const ready =
      applications &&
      ["ready-for-review", "medic-applicant"].includes(profile) &&
      options.scenario !== "none-ready";
    const fullName = names[variant]!;
    const [firstName, lastName] = fullName.split(" ");
    const name = personDisplayName({
      firstName,
      lastName,
      preferredName:
        options.scenario === "long-names" ? longPreferredNames[variant] : "",
    });
    searchNames.set(id, fullName);
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
      medicMark: Number(
        applications
          ? profile === "medic-applicant" && options.scenario !== "none-ready"
          : [1, 4, 6].includes(variant),
      ),
      active: Number(variant !== 7),
      applicationApproved: Number(!applications),
      applicationReadyForReview: Number(!applications || ready),
      applicationRejectionReason:
        applications && profile === "rejected"
          ? "Fictional application review decision."
          : null,
      applicationCompletedAt:
        !applications || ready || profile === "rejected"
          ? Date.UTC(2026, 8, 15 + index, 18, 30)
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
    compareSearch(`${person.name} ${searchNames.get(person.id)}`, state.search),
  );
  const awaiting = matching.filter(
    (person) =>
      person.applicationReadyForReview && !person.applicationRejectionReason,
  );
  const filtered =
    applications && state.approval === "awaiting" ? awaiting : matching;
  filtered.sort((a, b) => {
    const primary = (person: Person) =>
      applications
        ? state.sort === "progress"
          ? progressOrder(person)
          : state.sort === "role"
            ? person.medicMark
              ? "Medic"
              : ""
            : state.sort === "completed"
              ? (person.applicationCompletedAt ?? -Infinity)
              : person.name
        : state.sort === "role"
          ? roleLabel(person)
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
