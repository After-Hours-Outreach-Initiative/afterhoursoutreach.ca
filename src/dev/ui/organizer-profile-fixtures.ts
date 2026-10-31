import type { ComponentProps } from "astro/types";
import type VolunteerProfileView from "../../components/volunteer/VolunteerProfileView.astro";
import {
  applicationDisplayName,
  type ApplicationAnswers,
} from "../../data/application";
import { codeOfConductVersion } from "../../data/code-of-conduct";

export type ProfileFixture = ComponentProps<typeof VolunteerProfileView>;

interface ProfileScenario {
  id: string;
  group: string;
  label: string;
  description: string;
  approved?: boolean;
  patrol?: boolean;
  medic?: boolean;
  booked?: boolean;
  attended?: boolean;
  inactive?: boolean;
  organizer?: boolean;
}

/** Only states an organizer can actually see: unsubmitted drafts stay private. */
export const organizerProfileScenarios: ProfileScenario[] = import.meta.env.DEV
  ? [
      {
        id: "naloxone-pending",
        group: "Application review",
        label: "Training incomplete",
        description:
          "Submitted application, with Naloxone 101 still outstanding.",
      },
      {
        id: "ready-for-review",
        group: "Application review",
        label: "Ready for review",
        description:
          "All applicant steps complete; review, approve, or reject the application.",
      },
      {
        id: "rejected",
        group: "Application review",
        label: "Application rejected",
        description:
          "A rejected application with its recorded, multiline reason.",
      },
      {
        id: "medic-applicant",
        group: "Application review",
        label: "Medic applicant",
        description:
          "A review-ready application with medic team interest, not yet approved.",
        medic: true,
      },
      {
        id: "accepted",
        group: "Orientation",
        label: "New volunteer",
        description:
          "Application approved, with no orientation booked or attended.",
        approved: true,
      },
      {
        id: "orientation-booked",
        group: "Orientation",
        label: "Orientation booked",
        description: "A new volunteer registered for an upcoming orientation.",
        approved: true,
        booked: true,
      },
      {
        id: "orientation-completed",
        group: "Orientation",
        label: "Orientation completed",
        description:
          "Recorded orientation attendance, awaiting patrol approval.",
        approved: true,
        attended: true,
      },
      {
        id: "medic-new-volunteer",
        group: "Orientation",
        label: "New medic volunteer",
        description:
          "Medic team interest and certification, before orientation and patrol approval.",
        approved: true,
        medic: true,
      },
      {
        id: "outreach-volunteer",
        group: "Volunteer access",
        label: "Outreach volunteer",
        description: "Application, orientation, and patrol access approved.",
        approved: true,
        attended: true,
        patrol: true,
      },
      {
        id: "medic",
        group: "Volunteer access",
        label: "Medic",
        description:
          "An oriented, patrol-approved volunteer with medic team interest.",
        approved: true,
        attended: true,
        patrol: true,
        medic: true,
      },
      {
        id: "inactive",
        group: "Volunteer access",
        label: "Inactive volunteer",
        description:
          "Existing approvals retained while the account is inactive.",
        approved: true,
        attended: true,
        patrol: true,
        inactive: true,
      },
      {
        id: "organizer",
        group: "Volunteer access",
        label: "Organizer account",
        description:
          "An organizer profile with the account-role and access controls.",
        approved: true,
        attended: true,
        patrol: true,
        organizer: true,
      },
      {
        id: "historic-approval",
        group: "Historical records",
        label: "Unknown approving organizer",
        description:
          "An older approval without an approving organizer or approval date.",
        approved: true,
      },
      {
        id: "legacy-application",
        group: "Historical records",
        label: "Missing original application",
        description:
          "An older account falls back to current answers when its original submission was not recorded.",
        approved: true,
        attended: true,
        patrol: true,
      },
      {
        id: "profile-updated",
        group: "Historical records",
        label: "Profile changed since applying",
        description:
          "Updated contact details and training, alongside the immutable original application.",
        approved: true,
        attended: true,
        patrol: true,
      },
      {
        id: "legacy-patrol",
        group: "Historical records",
        label: "Patrol access without attendance",
        description:
          "A historical patrol approval without recorded orientation attendance.",
        approved: true,
        patrol: true,
        medic: true,
      },
    ]
  : [];

export const profileViewports = [
  "fit",
  "1440",
  "1024",
  "768",
  "375",
  "320",
] as const;
export const profileContents = ["standard", "long", "minimal"] as const;
export const profilePhases = ["ready", "loading", "load-error"] as const;
export const profileOutcomes = [
  "success",
  "failure",
  "conflict",
  "email-failure",
  "pending",
] as const;

export interface ProfilePreviewOptions {
  scenario: string;
  viewport: (typeof profileViewports)[number];
  content: (typeof profileContents)[number];
  phase: (typeof profilePhases)[number];
  outcome: (typeof profileOutcomes)[number];
  latency: number;
  height: number;
}

export interface ProfileSimulationState {
  approved: boolean;
  patrol: boolean;
  patrolChangedAt: number | null;
  active: boolean;
  role: "volunteer" | "organizer";
  rejection: string | null;
}

export const profileChannel = "ahoi-local-ui-organizer-profile";
export const profileWorkspacePath = "/dev/ui/organizer-profile";
export const profilePreviewPath = `${profileWorkspacePath}/preview`;
const timestamp = Date.UTC(2026, 0, 12, 18);

export function getProfileScenario(id: string | null) {
  if (!import.meta.env.DEV)
    throw new Error("UI fixtures are local-development only.");
  return (
    organizerProfileScenarios.find((scenario) => scenario.id === id) ??
    organizerProfileScenarios.find(
      (scenario) => scenario.id === "ready-for-review",
    )!
  );
}

export function readProfileOptions(
  params: URLSearchParams,
): ProfilePreviewOptions {
  const latency = Number(params.get("latency") ?? 600);
  const height = Number(params.get("height") ?? 800);
  return {
    scenario: getProfileScenario(params.get("scenario")).id,
    viewport:
      profileViewports.find((value) => value === params.get("viewport")) ??
      "fit",
    content:
      profileContents.find((value) => value === params.get("content")) ??
      "standard",
    phase:
      profilePhases.find((value) => value === params.get("phase")) ?? "ready",
    outcome:
      profileOutcomes.find((value) => value === params.get("outcome")) ??
      "success",
    latency: Number.isFinite(latency)
      ? Math.max(0, Math.min(5000, Math.round(latency)))
      : 600,
    height: Number.isFinite(height)
      ? Math.max(360, Math.min(1200, Math.round(height)))
      : 800,
  };
}

export function profileQuery(options: ProfilePreviewOptions) {
  return new URLSearchParams(
    Object.entries(options).map(([key, value]) => [key, String(value)]),
  );
}

export function readProfileState(
  params: URLSearchParams,
): ProfileSimulationState | undefined {
  if (!params.has("simulated")) return;
  const patrolChangedAt = Number(params.get("patrolChangedAt") ?? NaN);
  return {
    approved: params.get("approved") === "1",
    patrol: params.get("patrol") === "1",
    patrolChangedAt:
      Number.isSafeInteger(patrolChangedAt) &&
      patrolChangedAt >= 0 &&
      patrolChangedAt <= 8.64e15
        ? patrolChangedAt
        : null,
    active: params.get("active") === "1",
    role: params.get("role") === "organizer" ? "organizer" : "volunteer",
    rejection: (params.get("rejection") ?? "").slice(0, 2000) || null,
  };
}

export function profileStateQuery(
  options: ProfilePreviewOptions,
  state: ProfileSimulationState,
) {
  const query = profileQuery(options);
  query.set("simulated", "1");
  for (const key of ["approved", "patrol", "active"] as const)
    query.set(key, state[key] ? "1" : "0");
  if (state.patrolChangedAt !== null)
    query.set("patrolChangedAt", String(state.patrolChangedAt));
  query.set("role", state.role);
  query.set("rejection", state.rejection ?? "");
  return query;
}

export function profileSimulationState(
  fixture: ProfileFixture,
): ProfileSimulationState {
  return {
    approved: Boolean(fixture.person.applicationApproved),
    patrol: Boolean(fixture.person.patrolApproved),
    patrolChangedAt: fixture.profile.patrolAccessChangedBy?.changedAt ?? null,
    active: Boolean(fixture.person.active),
    role: fixture.person.role,
    rejection: fixture.person.applicationRejectionReason,
  };
}

export function createProfileFixture(
  options: ProfilePreviewOptions,
  state?: ProfileSimulationState,
): ProfileFixture {
  const scenario = getProfileScenario(options.scenario);
  const answers: ApplicationAnswers = {
    firstName: "Alex",
    middleNames: "Jordan",
    lastName: "Rivera",
    preferredName: "Alex",
    pronouns: "they/them",
    phone: "604-555-0142",
    birthDate: "1994-06-18",
    emergencyName: "Sam Rivera",
    emergencyPhone: "604-555-0183",
    emergencyRelationship: "Sibling",
    heardAboutUs: "",
    heardAboutUsSources: ["friend-word-of-mouth"],
    heardAboutUsOther: "",
    motivation:
      "I want to support neighbour-led outreach and help people access supplies, practical care, and a welcoming conversation.",
    teams: scenario.medic ? ["outreach", "medic"] : ["outreach"],
    certifications: scenario.medic ? ["advanced-first-aid"] : [],
    certificationExpiry: scenario.medic ? "2028-06-18" : "",
    certification: "",
    experience: "",
    training: ["naloxone-administration", "crisis-intervention"],
    expiredFirstAidDetails: "",
    crisisInterventionDetails:
      "Fictional community de-escalation workshop, 2025.",
    otherTraining: "",
    relevantExperience: ["dtes-vulnerable-populations"],
    otherExperience: "",
    medicalConditions: "No accommodations requested.",
  };
  if (options.content === "long") {
    answers.preferredName = "Alexandria Jordan Marie Jacqueline";
    answers.emergencyName =
      "Samira Jacqueline Rivera-Montgomery, primary emergency contact";
    answers.emergencyRelationship = "Sibling and designated emergency contact";
    answers.training = [
      "naloxone-administration",
      "expired-first-aid",
      "crisis-intervention",
      "mental-health-first-aid",
      "other",
    ];
    answers.expiredFirstAidDetails =
      "Previously completed a Standard First Aid course. The certification is no longer current.";
    answers.otherTraining =
      "Fictional accessibility and trauma-informed outreach workshops.\nPractised communicating clearly in loud, busy environments.";
    answers.relevantExperience = [
      "overdose-response",
      "lived-experience",
      "dtes-vulnerable-populations",
      "nonprofit-fundraising",
      "other",
    ];
    answers.otherExperience =
      "Helped coordinate a fictional neighbourhood supply drive and volunteer welcome sessions.\nComfortable working alongside a team and asking for support.";
    answers.medicalConditions =
      "Fictional layout example, not a real health record.\nPlease allow a short seated break during longer activities. I carry my own supplies and will discuss any accommodations with the team.";
    answers.motivation = Array(4)
      .fill(
        "I value consistent, respectful outreach that is led by the people in the community. I would like to contribute practical support, listen without judgment, and learn from experienced volunteers.",
      )
      .join("\n\n");
  } else if (options.content === "minimal") {
    for (const key of [
      "middleNames",
      "preferredName",
      "pronouns",
      "otherTraining",
      "crisisInterventionDetails",
      "medicalConditions",
    ] as const)
      answers[key] = "";
    answers.training = ["none"];
    answers.relevantExperience = ["none"];
  }
  const originalAnswers = structuredClone(answers);
  const originalEmail = "alex.rivera@example.org";
  let email = originalEmail;
  if (options.scenario === "profile-updated") {
    answers.phone = "604-555-0198";
    answers.emergencyName = "Casey Rivera";
    answers.medicalConditions =
      "Updated fictional accommodation request: a short seated break when needed.";
    email = "alex.updated@example.org";
  }
  if (options.content === "long")
    email =
      "alexandria.jordan.rivera-montgomery.fictional-volunteer@example.org";
  const approved = state?.approved ?? Boolean(scenario.approved);
  const patrol = state?.patrol ?? Boolean(scenario.patrol);
  const rejection = state
    ? state.rejection
    : options.scenario === "rejected"
      ? "Please gain more experience in a supported team setting before reapplying.\nYou are welcome to apply again in the future."
      : null;
  const naloxone =
    options.scenario === "naloxone-pending" ? null : timestamp + 86_400_000;
  const approvedAt =
    options.scenario === "historic-approval"
      ? null
      : timestamp + 2 * 86_400_000;
  const orientation = {
    eventId: "ui-fictional-orientation",
    startsAt: Date.UTC(2026, 1, 7, 21),
    meetingPoint: "Fictional Community Centre · Main entrance",
  };
  const patrolChangedAt =
    state?.patrolChangedAt ??
    (patrol && options.scenario !== "legacy-patrol"
      ? orientation.startsAt + 86_400_000
      : null);
  return {
    person: {
      id: "ui-fictional-volunteer",
      name: applicationDisplayName(answers),
      role: state?.role ?? (scenario.organizer ? "organizer" : "volunteer"),
      active: Number(state?.active ?? !scenario.inactive),
      applicationApproved: Number(approved),
      applicationReadyForReview: Number(naloxone !== null),
      applicationRejectionReason: rejection,
      patrolApproved: Number(patrol),
      updatedAt: timestamp,
      twoFactorEnabled: Number(Boolean(scenario.organizer)),
      orientations: Number(Boolean(scenario.attended)),
    },
    profile: {
      answers,
      email,
      submittedAt: new Date(timestamp).toISOString(),
      naloxoneCompletedAt: naloxone,
      codeOfConductVersion:
        options.scenario === "legacy-application" ? null : codeOfConductVersion,
      codeOfConductAcceptedAt:
        options.scenario === "legacy-application"
          ? null
          : new Date(timestamp).toISOString(),
      applicationApprovedBy:
        approved && approvedAt !== null
          ? {
              id: "ui-fictional-organizer",
              name: "Morgan C.",
              email: "morgan.organizer@example.org",
              approvedAt,
            }
          : null,
      patrolAccessChangedBy:
        patrolChangedAt !== null
          ? {
              id: "ui-fictional-organizer",
              name: "Morgan C.",
              email: "morgan.organizer@example.org",
              changedAt: patrolChangedAt,
            }
          : null,
      submission:
        options.scenario === "legacy-application"
          ? null
          : {
              version: 1,
              answers: originalAnswers,
              email: originalEmail,
              submittedAt: new Date(timestamp).toISOString(),
              codeOfConductVersion,
              codeOfConductAcceptedAt: new Date(timestamp).toISOString(),
            },
    },
    progress: {
      submittedAt: timestamp,
      naloxoneCompletedAt: naloxone,
      applicationApproved: approved,
      applicationApprovedAt: approved ? approvedAt : null,
      applicationRejectionReason: rejection,
    },
    orientation: scenario.booked
      ? { ...orientation, startsAt: Date.UTC(2027, 0, 16, 21) }
      : null,
    completedOrientation: scenario.attended ? orientation : null,
  };
}
