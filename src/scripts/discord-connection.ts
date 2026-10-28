import {
  discordConnectionDescription,
  discordConnectionIdentity,
  discordConnectionMessage,
  type DiscordConnectionStatus,
} from "@/data/discord-connection";

/** Update existing view nodes without attaching listeners or making requests. */
export function updateDiscordConnection(
  root: HTMLElement,
  status: DiscordConnectionStatus,
): void {
  root.querySelector<HTMLElement>("[data-discord-description]")!.textContent =
    discordConnectionDescription(
      status.configured,
      root.dataset.discordRequired === "true",
    );
  const identity = root.querySelector<HTMLElement>("[data-discord-identity]")!;
  identity.hidden = !status.username;
  identity.textContent = discordConnectionIdentity(status);
  const message = root.querySelector<HTMLElement>("[data-discord-status]")!;
  message.hidden = !status.configured || !status.username;
  message.textContent = discordConnectionMessage(status);
  root.querySelector<HTMLButtonElement>("[data-discord-refresh]")!.hidden =
    !status.configured || !status.username;
  const form = root.querySelector<HTMLFormElement>("[data-discord-connect]");
  if (form) {
    const focused = form.contains(root.ownerDocument.activeElement);
    form.hidden =
      !status.configured || Boolean(status.username && !status.needsReconnect);
    form.querySelector<HTMLElement>(
      "[data-discord-connect-label]",
    )!.textContent = status.needsReconnect
      ? "Reconnect Discord"
      : "Connect Discord";
    if (form.hidden && focused) identity.focus({ preventScroll: true });
  }
}
