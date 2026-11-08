import type { ApplicationProgress } from "../server/db/application-progress";

// A virtual choice, never the ID of a fixture or a saved application.
export const newApplicationPersona = "new-application";
export const accountStatePersona = (key: string) => `new-state:${key}`;
export const developmentStateProvider = "local-development-state";
export const developmentStateOrganizerId = "local-state-organizer";

export type DevelopmentApplicationStep =
  "form" | "naloxone" | "discord" | "review";

export const manualAccountGroups = [
  { key: "application", label: "Application" },
  { key: "orientation", label: "Orientation" },
  { key: "volunteers", label: "Active volunteers" },
  { key: "access", label: "Access" },
] as const;

type AccountGroup = (typeof manualAccountGroups)[number]["key"];
interface PresetState {
  sampleKey: "casey" | "alex" | "dana" | "jamie" | "robin";
  name: string;
  draft: boolean;
  rejected: boolean;
  naloxoneCompleted: boolean;
  applicationApproved: boolean;
  orientation: "none" | "booked" | "completed";
  patrolApproved: boolean;
  active: boolean;
  role: "volunteer" | "organizer";
}

// A new identity generation keeps older, edited samples as saved accounts rather
// than borrowing their histories for a different fictional person.
export const localAccountUserId = (key: string) =>
  `local-account-v2-user-${key}`;
const preset = (
  key: string,
  label: string,
  group: AccountGroup,
  name: string,
  state: Partial<PresetState> = {},
) =>
  ({
    key,
    id: localAccountUserId(key),
    label,
    group,
    name,
    sampleKey: "alex",
    draft: false,
    rejected: false,
    naloxoneCompleted: true,
    applicationApproved: true,
    orientation: "none",
    patrolApproved: false,
    active: true,
    role: "volunteer",
    ...state,
  }) satisfies PresetState & {
    key: string;
    id: string;
    label: string;
    group: AccountGroup;
  };

// Preset keys also identify seeded accounts; retired IDs remain protected below.
export const manualAccountPresets = [
  preset("draft", "Draft application", "application", "Casey Brook", {
    sampleKey: "casey",
    draft: true,
    naloxoneCompleted: false,
    applicationApproved: false,
  }),
  preset("applied", "Form submitted", "application", "Morgan Vale", {
    sampleKey: "casey",
    naloxoneCompleted: false,
    applicationApproved: false,
  }),
  preset("awaiting-review", "Ready for review", "application", "Taylor Reed", {
    sampleKey: "casey",
    applicationApproved: false,
  }),
  preset("applied-medic", "Medic form submitted", "application", "Avery Moss", {
    sampleKey: "dana",
    naloxoneCompleted: false,
    applicationApproved: false,
  }),
  preset(
    "awaiting-review-medic",
    "Medic ready for review",
    "application",
    "Quinn Flores",
    {
      sampleKey: "dana",
      applicationApproved: false,
    },
  ),
  preset("rejected", "Application rejected", "application", "Riley Stone", {
    sampleKey: "casey",
    applicationApproved: false,
    rejected: true,
  }),
  preset(
    "rejected-medic",
    "Medic application rejected",
    "application",
    "Emerson Lake",
    {
      sampleKey: "dana",
      applicationApproved: false,
      rejected: true,
    },
  ),
  preset("accepted", "Ready for orientation", "orientation", "Li"),
  preset(
    "orientation-booked",
    "Orientation booked",
    "orientation",
    "Alexandra Madeleine de la Cruz-Worthington-Smythe",
    {
      orientation: "booked",
    },
  ),
  preset(
    "orientation-completed",
    "Orientation completed",
    "orientation",
    "Sage Hart",
    {
      orientation: "completed",
    },
  ),
  preset(
    "medic-new-volunteer",
    "Medic awaiting orientation",
    "orientation",
    "Jo",
    {
      sampleKey: "dana",
      orientation: "booked",
    },
  ),
  preset(
    "patrol",
    "Outreach Volunteer",
    "volunteers",
    "Alexanderthegreatesteverlastingunbrokenvolunteernamefortablewrapping",
    {
      orientation: "completed",
      patrolApproved: true,
    },
  ),
  preset(
    "medic",
    "Medic",
    "volunteers",
    "Gabriella Dominique Josephine Montgomery-Fitzgerald",
    {
      sampleKey: "dana",
      orientation: "completed",
      patrolApproved: true,
    },
  ),
  preset("inactive", "Inactive new volunteer", "access", "Jamie Birch", {
    sampleKey: "jamie",
    active: false,
  }),
  preset("inactive-new-medic", "Inactive new medic", "access", "Drew Finch", {
    sampleKey: "dana",
    active: false,
  }),
  preset(
    "inactive-patrol",
    "Inactive outreach volunteer",
    "access",
    "Rowan Gale",
    {
      patrolApproved: true,
      active: false,
    },
  ),
  preset("inactive-medic", "Inactive medic", "access", "Sky Marlow", {
    sampleKey: "dana",
    patrolApproved: true,
    active: false,
  }),
  preset("organizer", "Organizer", "access", "Robin Ash", {
    sampleKey: "robin",
    role: "organizer",
    patrolApproved: true,
  }),
  preset("organizer-medic", "Organizer medic", "access", "Nico Wren", {
    sampleKey: "dana",
    role: "organizer",
    patrolApproved: true,
  }),
  preset(
    "organizer-new",
    "Organizer awaiting patrol approval",
    "access",
    "Sam Linden",
    {
      sampleKey: "robin",
      role: "organizer",
    },
  ),
  preset(
    "organizer-new-medic",
    "Organizer medic awaiting patrol approval",
    "access",
    "Adelaide Beatrice Clementine Saint-Clair-Montgomery",
    {
      sampleKey: "dana",
      role: "organizer",
    },
  ),
  preset("inactive-organizer", "Inactive organizer", "access", "Remy Elm", {
    sampleKey: "robin",
    role: "organizer",
    patrolApproved: true,
    active: false,
  }),
  preset(
    "inactive-organizer-medic",
    "Inactive organizer medic",
    "access",
    "Blair Cove",
    {
      sampleKey: "dana",
      role: "organizer",
      patrolApproved: true,
      active: false,
    },
  ),
];

// Only these exact manual preset IDs are protected, regardless of name or role.
export const manualAccountPresetIds: readonly string[] =
  manualAccountPresets.map(({ id }) => id);

export function isManualAccountPreset(userId: string) {
  // Keep a previously seeded identity protected; renaming the preset must not
  // make saved fixture edits eligible for deletion or reset its stored history.
  return (
    manualAccountPresetIds.includes(userId) ||
    [
      "draft",
      "applied",
      "awaiting-review",
      "accepted",
      "orientation-booked",
      "orientation-completed",
      "medic-new-volunteer",
      "medic-orientee",
      "patrol",
      "medic",
      "inactive",
      "organizer",
    ].some((key) => userId === `local-account-user-${key}`)
  );
}

export interface DevelopmentAccountState extends Pick<
  ApplicationProgress,
  | "submittedAt"
  | "naloxoneCompletedAt"
  | "applicationApproved"
  | "applicationRejectionReason"
  | "discordRequired"
  | "discordCompletedAt"
> {
  hasDraft: boolean;
  active: boolean;
  patrolApproved: boolean;
  orientationCompleted: boolean;
  orientationBooked: boolean;
  medicSelected: boolean;
  medicEligible: boolean;
  twoFactorEnabled: boolean;
}

/** Describe saved D1 state, not the state a preset originally promised. */
export function developmentAccountStatus(state: DevelopmentAccountState) {
  if (state.submittedAt === null)
    return state.hasDraft ? "Draft saved · Not submitted" : "Not submitted";
  const labels = [
    state.applicationRejectionReason
      ? "Application rejected"
      : state.naloxoneCompletedAt === null
        ? "Naloxone 101 incomplete"
        : state.discordRequired && state.discordCompletedAt == null
          ? "Discord connection incomplete"
          : !state.applicationApproved
            ? "Awaiting application approval"
            : "Application complete",
  ];
  if (!state.active) labels.push("Inactive");
  if (state.naloxoneCompletedAt === null && !state.applicationApproved)
    labels.push("Application not approved");
  labels.push(
    state.orientationCompleted
      ? "Orientation completed"
      : state.orientationBooked
        ? "Orientation booked"
        : "Orientation not completed",
  );
  labels.push(state.patrolApproved ? "Patrol approved" : "Not patrol approved");
  if (state.medicSelected)
    labels.push(
      state.medicEligible
        ? "Medic eligible"
        : "Medic team · Not medic eligible",
    );
  if (state.twoFactorEnabled) labels.push("Authenticator enabled");
  return labels.join(" · ");
}

/** State launchers describe their reset point, never saved account progress. */
export function developmentPresetStatus(
  preset: (typeof manualAccountPresets)[number],
) {
  return developmentAccountStatus({
    submittedAt: preset.draft ? null : 0,
    naloxoneCompletedAt: preset.naloxoneCompleted ? 0 : null,
    applicationApproved: preset.applicationApproved,
    applicationRejectionReason: preset.rejected
      ? "Sample application declined after review."
      : null,
    discordRequired: true,
    discordCompletedAt: preset.naloxoneCompleted ? 0 : null,
    hasDraft: preset.draft,
    active: preset.active,
    patrolApproved: preset.patrolApproved,
    orientationCompleted: preset.orientation === "completed",
    orientationBooked: preset.orientation === "booked",
    medicSelected: preset.sampleKey === "dana",
    medicEligible:
      preset.sampleKey === "dana" &&
      preset.active &&
      preset.applicationApproved &&
      preset.patrolApproved,
    twoFactorEnabled: false,
  });
}
