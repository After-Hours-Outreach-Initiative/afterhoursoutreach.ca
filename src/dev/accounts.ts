import type { ApplicationProgress } from "../server/db/application-progress";

// A virtual choice, never the ID of a fixture or a saved application.
export const newApplicationPersona = "new-application";

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

// IDs of the original presets stay stable; labels describe the current model.
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
  preset("awaiting-review", "Awaiting review", "application", {
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
  preset("medic-orientee", "Medic awaiting orientation", "orientation", {
    sampleKey: "dana",
  }),
  preset("patrol", "Patrol volunteer", "volunteers", {
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
  return manualAccountPresetIds.includes(userId);
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
