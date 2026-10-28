document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (
    !(form instanceof HTMLFormElement) ||
    !form.matches("[data-discord-connect]")
  )
    return;
  event.preventDefault();
  const root = form.closest<HTMLElement>("[data-discord-connection]")!;
  const message = form.querySelector<HTMLElement>("[data-discord-message]")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  if (button.disabled) return;
  button.disabled = true;
  message.hidden = true;
  try {
    let outcome: string | undefined;
    if (import.meta.env.DEV) {
      const { localDiscordDialog } =
        await import("../dev/scripts/local-discord-dialog");
      const chosen = await localDiscordDialog();
      if (!chosen) {
        message.textContent =
          "Discord connection was cancelled. You can try again.";
        message.hidden = false;
        button.disabled = false;
        return;
      }
      outcome = chosen;
    }
    const response = await fetch("/api/v1/account/discord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: root.dataset.discordUser,
        // Submitting starts authorization; permissions are approved on Discord.
        consent: true,
        ...(outcome ? { outcome } : {}),
      }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        errorSchema.parse(data).message ?? "Discord could not be connected.",
      );
    if (import.meta.env.DEV) {
      if (z.object({ simulated: z.literal(true) }).safeParse(data).success) {
        window.location.reload();
        return;
      }
      throw new Error("Discord could not be connected. Please try again.");
    }
    const target = new URL(urlSchema.parse(data).url);
    if (
      target.origin !== "https://discord.com" ||
      target.pathname !== "/oauth2/authorize"
    )
      throw new Error("Invalid Discord authorization address.");
    window.location.assign(target.href);
  } catch (error) {
    message.hidden = false;
    message.textContent =
      error instanceof Error
        ? error.message
        : "Discord could not be connected.";
    button.disabled = false;
  }
});
async function refresh(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>("[data-discord-status]")!;
  try {
    const response = await fetch("/api/v1/account/discord", {
      cache: "no-store",
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(
        errorSchema.parse(body).message ?? "Status is unavailable.",
      );
    const data = statusSchema.parse(body);
    if (data.userId !== root.dataset.discordUser)
      throw new Error("Your account changed. Reload this page.");
    const identity = root.querySelector<HTMLElement>(
      "[data-discord-identity]",
    )!;
    identity.hidden = !data.username;
    identity.textContent = data.username
      ? `Connected as ${data.username}.`
      : "";
    status.hidden = !data.configured || !data.username;
    status.textContent = data.username
      ? `${data.connection.replace(/\.$/, "")}. ${data.sync.replace(/\.$/, "")}.`
      : "";
    root.querySelector<HTMLButtonElement>("[data-discord-refresh]")!.hidden =
      !data.configured || !data.username;
  } catch (error) {
    status.hidden = false;
    status.textContent =
      error instanceof Error
        ? error.message
        : "Status is unavailable. Try refreshing again.";
  }
}
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const root = event.target
    .closest("[data-discord-refresh]")
    ?.closest<HTMLElement>("[data-discord-connection]");
  if (root) void refresh(root);
});
// Poll status only, never Discord's API. Refresh is also available without waiting.
let polls = 0;
const timer = window.setInterval(() => {
  if (++polls > 24) {
    window.clearInterval(timer);
    return;
  }
  if (!document.hidden)
    document
      .querySelectorAll<HTMLElement>("[data-discord-connection]")
      .forEach((root) => void refresh(root));
}, 5000);
import { z } from "zod";
const errorSchema = z.object({ message: z.string().optional() });
const urlSchema = z.object({ url: z.string() });
const statusSchema = z.object({
  userId: z.string(),
  configured: z.boolean(),
  username: z.string().nullable(),
  discordId: z.string().nullable(),
  connection: z.string(),
  sync: z.string(),
});
