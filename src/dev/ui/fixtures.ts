import {
  presentDiscordConnection,
  type DiscordConnectionLink,
  type DiscordConnectionStatus,
} from "../../data/discord-connection";

/** Fictional, deterministic data. Never load account or Discord server modules here. */
const timestamp = Date.UTC(2026, 0, 12, 18);
export const fakeUsername = "fictional.river";
export const longFakeUsername =
  "fictional.volunteer.with.an.intentionally.long.display.name.for.narrow.screen.layout.checks";

const linked: DiscordConnectionLink = {
  username: fakeUsername,
  discordId: "ui-fictional-discord-identity",
  completedAt: null,
  memberVerifiedAt: null,
  lastSyncedAt: null,
  lastError: null,
  version: 2,
  syncedVersion: 1,
};
const verified: DiscordConnectionLink = {
  ...linked,
  completedAt: timestamp,
  memberVerifiedAt: timestamp,
};
const synced: DiscordConnectionLink = {
  ...verified,
  lastSyncedAt: timestamp,
  syncedVersion: 2,
};

function present(link: DiscordConnectionLink | null, configured = true) {
  return presentDiscordConnection({
    userId: "ui-fictional-volunteer",
    configured,
    link,
  });
}

export type PreviewPhase =
  "idle" | "authorizing" | "connection-error" | "refresh-error";

export interface DiscordScenario {
  id: string;
  label: string;
  description: string;
  status: DiscordConnectionStatus;
  eligible?: boolean;
  result?: string;
  phase?: PreviewPhase;
}

// Connection and role synchronization are separate layers. A linked account can
// still be joining, in screening, or waiting for roles; it is not yet verified.
export const discordScenarios: DiscordScenario[] = import.meta.env.DEV
  ? [
      {
        id: "unavailable",
        label: "Unavailable",
        description:
          "Planned integration, with a concise placeholder and no actions.",
        status: present(null, false),
      },
      {
        id: "upcoming",
        label: "Upcoming / prerequisites",
        description:
          "The step description stays visible; connection actions are not available yet.",
        status: present(null),
        eligible: false,
      },
      {
        id: "not-connected",
        label: "Not connected",
        description: "Eligible to start a new Discord connection.",
        status: present(null),
      },
      {
        id: "authorizing",
        label: "Authorizing / loading",
        description:
          "A frozen in-flight connection. Reset or choose another scenario to leave it.",
        status: present(null),
        phase: "authorizing",
      },
      {
        id: "joining",
        label: "Joining the server",
        description:
          "Identity linked, but server membership has not been verified.",
        status: present(linked),
        result: "connected",
      },
      {
        id: "screening",
        label: "Membership screening",
        description:
          "Identity linked; the volunteer must accept the server rules in Discord.",
        status: present({
          ...linked,
          lastError: "membership_screening",
        }),
      },
      {
        id: "sync-pending",
        label: "Connected / role sync pending",
        description:
          "Membership verified; role synchronization is still pending.",
        status: present(verified),
      },
      {
        id: "synced",
        label: "Connected / roles synchronized",
        description:
          "Membership and current website eligibility are synchronized.",
        status: present(synced),
      },
      {
        id: "reconnect",
        label: "Reconnect / membership missing",
        description: "A previously linked identity is no longer in the server.",
        status: present({
          ...linked,
          completedAt: timestamp,
          lastError: "membership_missing",
        }),
      },
      {
        id: "bot-permissions",
        label: "Bot permissions unavailable",
        description:
          "Membership is verified; role synchronization will retry automatically.",
        status: present({
          ...verified,
          lastError: "bot_permissions",
        }),
      },
      {
        id: "rate-limited",
        label: "Rate limited",
        description:
          "Membership is verified; Discord has asked role synchronization to pause.",
        status: present({
          ...verified,
          lastError: "rate_limited",
        }),
      },
      {
        id: "sync-delayed",
        label: "Other synchronization delay",
        description:
          "Membership is verified; a recoverable synchronization error is being retried.",
        status: present({
          ...verified,
          lastError: "temporary_discord_error",
        }),
      },
      {
        id: "cancelled",
        label: "Authorization cancelled",
        description:
          "Authorization returned without consent; connecting remains available.",
        status: present(null),
        result:
          "Discord connection was cancelled. You can try again with consent.",
      },
      {
        id: "expired",
        label: "Authorization expired",
        description:
          "The authorization session expired before a connection was saved.",
        status: present(null),
        result: "Discord authorization expired. Start again.",
      },
      {
        id: "connection-failure",
        label: "Connection failure",
        description:
          "Connection failed without linking an identity; the action can be retried.",
        status: present(null),
        phase: "connection-error",
      },
      {
        id: "refresh-failure",
        label: "Refresh failure",
        description:
          "A status request failed, while the previously linked identity is retained.",
        status: present(synced),
        phase: "refresh-error",
      },
    ]
  : [];

export const connectOutcomes = [
  "authorize",
  "cancel",
  "failure",
  "screening",
  "expired",
] as const;
export const refreshOutcomes = [
  "success",
  "pause",
  "error",
  "reconnect",
  "pending",
] as const;

export interface PreviewOptions {
  scenario: string;
  required: boolean;
  eligible: boolean;
  username: string;
  latency: number;
  size: "narrow" | "desktop";
  connect: (typeof connectOutcomes)[number];
  refresh: (typeof refreshOutcomes)[number];
}

export function getDiscordScenario(id: string | null): DiscordScenario {
  if (!import.meta.env.DEV)
    throw new Error("UI fixtures are local-development only.");
  return (
    discordScenarios.find((scenario) => scenario.id === id) ??
    discordScenarios.find((scenario) => scenario.id === "not-connected")!
  );
}

export function readPreviewOptions(params: URLSearchParams): PreviewOptions {
  const scenario = getDiscordScenario(params.get("scenario"));
  const latency = Number(params.get("latency") ?? 700);
  const username = (params.get("username") ?? fakeUsername)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 160);
  return {
    scenario: scenario.id,
    required: params.getAll("required").at(-1) !== "0",
    eligible: params.has("eligible")
      ? params.getAll("eligible").at(-1) !== "0"
      : scenario.eligible !== false,
    username: username || fakeUsername,
    latency: Number.isFinite(latency)
      ? Math.min(5000, Math.max(0, Math.round(latency)))
      : 700,
    size: params.get("size") === "narrow" ? "narrow" : "desktop",
    connect:
      connectOutcomes.find((outcome) => outcome === params.get("connect")) ??
      "authorize",
    refresh:
      refreshOutcomes.find((outcome) => outcome === params.get("refresh")) ??
      "success",
  };
}

export function previewQuery(options: PreviewOptions): URLSearchParams {
  return new URLSearchParams({
    scenario: options.scenario,
    required: options.required ? "1" : "0",
    eligible: options.eligible ? "1" : "0",
    username: options.username,
    latency: String(options.latency),
    size: options.size,
    connect: options.connect,
    refresh: options.refresh,
  });
}

export function fixtureStatus(
  scenario: DiscordScenario,
  username: string,
): DiscordConnectionStatus {
  if (!import.meta.env.DEV)
    throw new Error("UI fixtures are local-development only.");
  return {
    ...scenario.status,
    username: scenario.status.username ? username : null,
  };
}

export const playgroundChannel = "ahoi-local-ui-discord";
