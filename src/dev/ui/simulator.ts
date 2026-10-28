import { updateDiscordConnection } from "../../scripts/discord-connection";
import {
  fixtureStatus,
  getDiscordScenario,
  playgroundChannel,
  readPreviewOptions,
} from "./fixtures";

/** An in-memory transport, not an API mock or a bypass on an application route. */
function initializeSimulator() {
  const preview = document.querySelector<HTMLElement>(
    "[data-ui-discord-preview]",
  );
  const root = preview?.querySelector<HTMLElement>("[data-discord-connection]");
  if (!preview || !root) return;
  const gallery = preview.dataset.gallery === "true";
  let options = readPreviewOptions(new URLSearchParams(window.location.search));
  const initialScenario = getDiscordScenario(options.scenario);
  let status = fixtureStatus(initialScenario, options.username);
  let phase: string = initialScenario.phase ?? "idle";
  let generation = 0;

  const form = root.querySelector<HTMLFormElement>("[data-discord-connect]");
  const connectButton = form?.querySelector<HTMLButtonElement>(
    "button[type=submit]",
  );
  const connectLabel = form?.querySelector<HTMLElement>(
    "[data-discord-connect-label]",
  );
  const message = form?.querySelector<HTMLElement>("[data-discord-message]");
  const refreshButton = root.querySelector<HTMLButtonElement>(
    "[data-discord-refresh]",
  );
  const statusText = root.querySelector<HTMLElement>("[data-discord-status]");

  function report() {
    if (window.parent === window) return;
    const panel = preview!.querySelector<HTMLElement>(".preview-panel");
    const padding = parseFloat(getComputedStyle(preview!).paddingBottom) || 0;
    window.parent.postMessage(
      {
        channel: playgroundChannel,
        type: "state",
        scenario: options.scenario,
        phase,
        status,
        height: Math.ceil(
          (panel?.getBoundingClientRect().bottom ?? 300) + padding,
        ),
      },
      window.location.origin,
    );
  }

  function render() {
    updateDiscordConnection(root!, status);
    const busy = phase === "authorizing" || phase === "refreshing";
    root!.setAttribute("aria-busy", String(busy));
    root!.dataset.uiPhase = phase;
    if (connectButton) connectButton.disabled = busy;
    if (refreshButton) {
      refreshButton.disabled = busy;
      refreshButton.textContent =
        phase === "refreshing" ? "Refreshing status..." : "Refresh status";
    }
    if (connectLabel && phase === "authorizing")
      connectLabel.textContent = "Connecting Discord...";
    if (message) {
      const messages: Record<string, string> = {
        "connection-error": "Discord could not be connected. Please try again.",
        cancelled: "Discord connection was cancelled. You can try again.",
        expired: getDiscordScenario("expired").result!,
      };
      message.textContent = messages[phase] ?? "";
      message.hidden = !message.textContent;
    }
    if (phase === "refresh-error" && statusText) {
      statusText.hidden = false;
      statusText.textContent = "Status is unavailable. Try refreshing again.";
    }
    report();
  }

  function applyScenario(id: string) {
    const scenario = getDiscordScenario(id);
    status = fixtureStatus(scenario, options.username);
    phase = id;
    render();
  }

  const wait = (milliseconds: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

  async function connect() {
    if (
      gallery ||
      !options.eligible ||
      !status.configured ||
      connectButton?.disabled
    )
      return;
    const current = ++generation;
    const { connect: outcome, latency } = options;
    root!.querySelector(".volunteer-notice")?.remove();
    phase = "authorizing";
    render();
    await wait(latency);
    if (current !== generation) return;
    if (outcome === "authorize") {
      applyScenario("joining");
      await wait(latency);
      if (current !== generation) return;
      applyScenario("sync-pending");
      await wait(latency);
      if (current !== generation) return;
      applyScenario("synced");
    } else if (outcome === "screening") {
      applyScenario("screening");
    } else {
      phase =
        outcome === "failure"
          ? "connection-error"
          : outcome === "cancel"
            ? "cancelled"
            : "expired";
      render();
    }
  }

  async function refresh() {
    if (gallery || !status.username || refreshButton?.disabled) return;
    const current = ++generation;
    const { refresh: outcome, latency } = options;
    phase = "refreshing";
    render();
    await wait(latency);
    if (current !== generation) return;
    if (outcome === "error") {
      phase = "refresh-error";
      render();
    } else {
      applyScenario(
        outcome === "pause"
          ? "rate-limited"
          : outcome === "reconnect"
            ? "reconnect"
            : outcome === "pending"
              ? "sync-pending"
              : "synced",
      );
    }
  }

  // Capture submission even in inert galleries: no form can ever reach a normal
  // API, and no application Discord script or polling initializer is imported.
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target === form) void connect();
  });
  refreshButton?.addEventListener("click", () => void refresh());

  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.origin !== window.location.origin ||
      event.source !== window.parent ||
      event.data?.channel !== playgroundChannel
    )
      return;
    if (event.data.type === "request-state") {
      report();
      return;
    }
    if (
      gallery ||
      event.data.type !== "configure" ||
      typeof event.data.query !== "string"
    )
      return;
    const next = readPreviewOptions(new URLSearchParams(event.data.query));
    // Structural props must be server-rendered by the real Astro component.
    if (
      next.scenario !== options.scenario ||
      next.eligible !== options.eligible ||
      next.required !== options.required
    )
      return;
    options = next;
    if (status.username) status = { ...status, username: options.username };
    render();
  });

  render();
  const panel = preview.querySelector(".preview-panel");
  if (panel) new ResizeObserver(report).observe(panel);
}

if (import.meta.env.DEV) initializeSimulator();
