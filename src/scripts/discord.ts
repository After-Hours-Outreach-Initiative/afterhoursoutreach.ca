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
  button.disabled = true;
  try {
    const response = await fetch("/api/v1/account/discord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: root.dataset.discordUser,
        consent: new FormData(form).get("consent") === "on",
      }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        errorSchema.parse(data).message ?? "Discord could not be connected.",
      );
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
    root.querySelector<HTMLElement>("[data-discord-identity]")!.textContent =
      data.username
        ? `Linked Discord: ${data.username} (${data.discordId})`
        : "No Discord identity linked.";
    status.textContent = `${data.connection.replace(/\.$/, "")}. ${data.sync.replace(/\.$/, "")}.`;
  } catch (error) {
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
  username: z.string().nullable(),
  discordId: z.string().nullable(),
  connection: z.string(),
  sync: z.string(),
});
