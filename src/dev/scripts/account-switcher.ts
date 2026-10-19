import { createAuthClient } from "better-auth/client";
import { InferServerPlugin } from "better-auth/client/plugins";
import type { AccountAuth } from "../../server/auth";
import { authClient } from "../../scripts/auth-client";
import { accountErrorMessage } from "../../scripts/account-forms";
import { newApplicationPersona } from "../accounts";

// This module is loaded only in development; server imports are type-only.
const developmentAuthClient = createAuthClient({
  basePath: "/api/v1/auth",
  fetchOptions: { credentials: "same-origin", throw: true },
  plugins: [
    {
      ...InferServerPlugin<AccountAuth, "development-accounts">(),
      pathMethods: {
        "/dev/users": "GET",
        "/dev/switch-user": "POST",
        "/dev/delete-user": "POST",
      },
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
  const profiles = root?.querySelector<HTMLElement>("[data-view-as]");
  const message = root?.querySelector<HTMLElement>("[data-switch-message]");
  if (!root || !profiles || !message) return;
  const createAccount = root.querySelector<HTMLAnchorElement>(
    "[data-create-account]",
  );
  let busy = true;
  const setBusy = (value: boolean) => {
    busy = value;
    profiles.setAttribute("aria-busy", String(value));
    profiles
      .querySelectorAll<HTMLButtonElement>(
        "[data-switch-user], [data-delete-user]",
      )
      .forEach((button) => (button.disabled = value));
    createAccount?.setAttribute("aria-disabled", String(value));
  };
  setBusy(true);
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
    message.textContent = accountErrorMessage(error);
    message.hidden = false;
  };
  createAccount?.addEventListener("click", async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    message.hidden = true;
    try {
      await authClient.signOut();
      location.assign("/volunteer/sign-in");
    } catch (error) {
      setBusy(false);
      fail(error);
    }
  });
  profiles.addEventListener("click", async (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(
            "button[data-switch-user], button[data-delete-user]",
          )
        : null;
    if (!button || !profiles.contains(button) || button.disabled || busy)
      return;
    if (button.dataset.deleteUser) {
      if (
        !window.confirm(
          `Delete ${button.dataset.deleteName}? This permanently removes this local test account, its application, and its draft.`,
        )
      )
        return;
      setBusy(true);
      message.hidden = true;
      try {
        const result = await developmentAuthClient.dev.deleteUser({
          userId: button.dataset.deleteUser,
          confirm: true,
        });
        if (result.next) {
          location.assign(result.next);
          return;
        }
        button.closest("[data-disposable-account]")?.remove();
        setBusy(false);
        profiles
          .querySelector<HTMLButtonElement>("[data-switch-user]")
          ?.focus();
        message.textContent = "Local test account deleted.";
        message.hidden = false;
      } catch (error) {
        setBusy(false);
        fail(error);
      }
      return;
    }
    setBusy(true);
    message.hidden = true;
    try {
      const result = await developmentAuthClient.dev.switchUser({
        userId: button.dataset.switchUser || null,
        returnTo: location.pathname + location.search,
      });
      location.assign(result.next || "/volunteer");
    } catch (error) {
      setBusy(false);
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
    const personaOrder = new Map([
      ["local-account-user-applied", 0],
      ["local-account-user-accepted", 1],
      ["local-account-user-inactive", 2],
      ["local-account-user-organizer", 3],
    ]);
    users.sort(
      (a, b) =>
        (personaOrder.get(a.id) ?? personaOrder.size) -
          (personaOrder.get(b.id) ?? personaOrder.size) ||
        (a.name || a.email).localeCompare(b.name || b.email),
    );
    const profileButton = (id: string, label: string, description: string) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-quiet account-profile-button";
      button.dataset.switchUser = id;
      const name = document.createElement("span");
      name.textContent = label;
      const detail = document.createElement("span");
      detail.className = "account-profile-detail";
      detail.textContent = description;
      button.appendChild(name);
      button.appendChild(detail);
      return button;
    };
    profiles.appendChild(
      profileButton(
        newApplicationPersona,
        "Not applied",
        "Start a new empty application",
      ),
    );
    for (const user of users) {
      const label =
        user.id === "local-account-user-not-applied" &&
        user.name === "Not applied"
          ? "Original Not applied account"
          : user.name || "Not yet applied";
      const button = profileButton(
        user.id,
        label,
        `${user.email}${user.role === "organizer" ? " · Organizer" : ""}`,
      );
      if (user.canDelete) {
        const row = document.createElement("div");
        row.className = "grid min-w-0 gap-1";
        row.dataset.disposableAccount = user.id;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn btn-quiet";
        remove.textContent = "Delete";
        remove.setAttribute("aria-label", `Delete ${label} (${user.email})`);
        remove.dataset.deleteUser = user.id;
        remove.dataset.deleteName = `${label} (${user.email})`;
        row.appendChild(button);
        row.appendChild(remove);
        profiles.appendChild(row);
      } else {
        profiles.appendChild(button);
      }
    }
    profiles
      .querySelectorAll<HTMLButtonElement>("[data-switch-user]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.switchUser === (currentUserId ?? "")),
        ),
      );
    setBusy(false);
  } catch (error) {
    setBusy(false);
    fail(error);
  }
}
