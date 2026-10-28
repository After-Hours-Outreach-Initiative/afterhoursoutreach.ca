import {
  discordConnectionDescription,
  discordConnectionMessage,
  type DiscordConnectionStatus,
} from "@/data/discord-connection";

/** Update existing view nodes without attaching listeners or making requests. */
export function updateDiscordConnection(
  root: HTMLElement,
  status: DiscordConnectionStatus,
): void {
  const canConnect = root.dataset.discordCanConnect === "true";
  const description = root.querySelector<HTMLElement>(
    "[data-discord-description]",
  )!;
  description.textContent = discordConnectionDescription(
    status,
    root.dataset.discordRequired === "true",
    canConnect,
  );
  description.hidden = !description.textContent;
  const identity = root.querySelector<HTMLElement>("[data-discord-identity]")!;
  identity.hidden = !status.username;
  identity.querySelector<HTMLElement>("[data-discord-username]")!.textContent =
    status.username ? `@${status.username}` : "";
  const message = root.querySelector<HTMLElement>("[data-discord-status]")!;
  message.textContent = discordConnectionMessage(status);
  message.hidden = !status.configured || !message.textContent;
  const form = root.querySelector<HTMLFormElement>("[data-discord-connect]");
  if (form) {
    const focused = form.contains(root.ownerDocument.activeElement);
    form.hidden =
      !status.configured ||
      !canConnect ||
      Boolean(status.username && !status.needsReconnect);
    form.querySelector<HTMLElement>(
      "[data-discord-connect-label]",
    )!.textContent = status.needsReconnect
      ? "Reconnect Discord"
      : "Connect Discord";
    if (form.hidden && focused) identity.focus({ preventScroll: true });
  }
}
