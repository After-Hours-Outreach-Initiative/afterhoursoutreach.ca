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
  draft: boolean;
  naloxoneCompleted: boolean;
  applicationApproved: boolean;
  orientation: "none" | "booked" | "completed";
  patrolApproved: boolean;
  active: boolean;
  role: "volunteer" | "organizer";
}

export const localAccountUserId = (key: string) => `local-account-user-${key}`;
const preset = (
  key: string,
  label: string,
  group: AccountGroup,
  state: Partial<PresetState> = {},
) =>
  ({
    key,
    id: localAccountUserId(key),
    label,
    group,
    sampleKey: "alex",
    draft: false,
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
  preset("draft", "Draft application", "application", {
    sampleKey: "casey",
    draft: true,
    naloxoneCompleted: false,
    applicationApproved: false,
  }),
  preset("applied", "Form submitted", "application", {
    sampleKey: "casey",
    naloxoneCompleted: false,
    applicationApproved: false,
  }),
  preset("awaiting-review", "Ready for review", "application", {
    sampleKey: "casey",
    applicationApproved: false,
  }),
  preset("accepted", "Ready for orientation", "orientation"),
  preset("orientation-booked", "Orientation booked", "orientation", {
    orientation: "booked",
  }),
  preset("orientation-completed", "Orientation completed", "orientation", {
    orientation: "completed",
  }),
  preset("medic-new-volunteer", "Medic awaiting orientation", "orientation", {
    sampleKey: "dana",
  }),
  preset("patrol", "Outreach Volunteer", "volunteers", {
    orientation: "completed",
    patrolApproved: true,
  }),
  preset("medic", "Medic", "volunteers", {
    sampleKey: "dana",
    orientation: "completed",
    patrolApproved: true,
  }),
  preset("inactive", "Inactive", "access", {
    sampleKey: "jamie",
    active: false,
  }),
  preset("organizer", "Organizer", "access", {
    sampleKey: "robin",
    role: "organizer",
    patrolApproved: true,
  }),
];

// Only these exact manual preset IDs are protected, regardless of name or role.
export const manualAccountPresetIds: readonly string[] =
  manualAccountPresets.map(({ id }) => id);

export function isManualAccountPreset(userId: string) {
  // Keep a previously seeded identity protected; renaming the preset must not
  // make saved fixture edits eligible for deletion or reset its stored history.
  return (
    manualAccountPresetIds.includes(userId) ||
    userId === "local-account-user-medic-orientee"
  );
}

export interface DevelopmentAccountState extends Pick<
  ApplicationProgress,
  | "submittedAt"
  | "naloxoneCompletedAt"
  | "applicationApproved"
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
    state.naloxoneCompletedAt === null
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
