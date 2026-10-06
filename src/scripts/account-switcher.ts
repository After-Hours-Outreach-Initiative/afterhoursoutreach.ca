import { createAuthClient } from "better-auth/client";
import { InferServerPlugin } from "better-auth/client/plugins";
import type { AccountAuth } from "../server/auth";
import { authClient } from "./auth-client";

// This module is loaded only in development; server imports are type-only.
const developmentAuthClient = createAuthClient({
  fetchOptions: { credentials: "same-origin", throw: true },
  plugins: [
    {
      ...InferServerPlugin<AccountAuth, "development-accounts">(),
      pathMethods: { "/dev/users": "GET", "/dev/switch-user": "POST" },
    },
  ],
});

type DevelopmentUsers = Awaited<
  ReturnType<typeof developmentAuthClient.dev.users>
>;
type DevelopmentUser = DevelopmentUsers["users"][number];

export async function initAccountSwitcher() {
  const root = document.querySelector<HTMLDialogElement>(
    "dialog[data-account-switcher]",
  );
  const select = root?.querySelector("[data-view-as]");
  const message = root?.querySelector<HTMLElement>("[data-switch-message]");
  if (!root || !(select instanceof HTMLSelectElement) || !message) return;
  const trigger = document.querySelector<HTMLButtonElement>(
    "[data-open-account-switcher]",
  );
  trigger?.addEventListener("click", () => {
    root.showModal();
    trigger?.setAttribute("aria-expanded", "true");
  });
  root
    .querySelector<HTMLButtonElement>("[data-close-account-switcher]")
    ?.addEventListener("click", () => root.close());
  root.addEventListener("close", () => {
    trigger?.setAttribute("aria-expanded", "false");
  });
  root.addEventListener("click", (event) => {
    if (event.target !== root) return;
    const bounds = root.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      root.close();
  });
  const fail = (error: unknown) => {
    message.textContent =
      error instanceof Error ? error.message : "Could not switch accounts.";
    message.hidden = false;
  };
  root
    .querySelector<HTMLAnchorElement>("[data-create-account]")
    ?.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        await authClient.signOut();
        location.assign("/volunteer/sign-in");
      } catch (error) {
        fail(error);
      }
    });
  try {
    const users: DevelopmentUser[] = [];
    let after: string | null = null;
    let currentUserId: string | null = null;
    do {
      const result: DevelopmentUsers = await developmentAuthClient.dev.users({
        query: after ? { after } : {},
      });
      users.push(...result.users);
      after = result.next;
      currentUserId = result.currentUserId;
    } while (after);
    users.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    for (const user of users) {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = `${user.name || "Not registered"} · ${user.email}${user.role === "organizer" ? " · Organizer" : ""}`;
      select.appendChild(option);
    }
    select.value = currentUserId ?? "";
    select.disabled = false;
    select.addEventListener("change", async () => {
      select.disabled = true;
      message.hidden = true;
      try {
        const result = await developmentAuthClient.dev.switchUser({
          userId: select.value || null,
          returnTo: location.pathname + location.search,
        });
        location.assign(result.next || "/volunteer");
      } catch (error) {
        select.value = currentUserId ?? "";
        select.disabled = false;
        fail(error);
      }
    });
  } catch (error) {
    fail(error);
  }
}
