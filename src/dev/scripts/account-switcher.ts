import { createAuthClient } from "better-auth/client";
import { InferServerPlugin } from "better-auth/client/plugins";
import type { AccountAuth } from "../../server/auth";
import { authClient } from "../../scripts/auth-client";
import { accountErrorMessage } from "../../scripts/account-forms";
import {
  developmentAccountStatus,
  manualAccountGroups,
  manualAccountPresets,
  manualAccountPresetIds,
  newApplicationPersona,
  type DevelopmentApplicationStep,
} from "../accounts";

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
        "/dev/application-step": "POST",
        "/dev/seed-accounts": "POST",
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
  const states = root?.querySelector<HTMLElement>("[data-account-states]");
  const accounts = root?.querySelector<HTMLElement>("[data-existing-accounts]");
  const message = root?.querySelector<HTMLElement>("[data-switch-message]");
  if (!root || !profiles || !states || !accounts || !message) return;
  const emptyAccounts = root.querySelector<HTMLElement>(
    "[data-empty-accounts]",
  );
  const stepAccount = root.querySelector<HTMLElement>("[data-step-account]");
  const steps = root.querySelectorAll<HTMLButtonElement>(
    "[data-application-step]",
  );
  const createAccount = root.querySelector<HTMLAnchorElement>(
    "[data-create-account]",
  );
  const seedAccounts = root.querySelector<HTMLButtonElement>(
    "[data-seed-accounts]",
  );
  let busy = true;
  let currentUserId: string | null = null;
  let progress: DevelopmentUsers["applicationProgress"] = null;
  let pendingDelete: HTMLButtonElement | undefined;
  const showDeleteConfirmation = (
    button: HTMLButtonElement,
    confirming: boolean,
  ) => {
    const label = `${confirming ? "Confirm deletion of" : "Delete"} ${button.dataset.deleteName}`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.toggleAttribute("data-delete-confirming", confirming);
    button.classList.toggle("btn-quiet", !confirming);
    button.classList.toggle("btn-red", confirming);
    const icon = button.querySelector("svg")!;
    icon.replaceChildren();
    // Match CheckIcon.astro and TrashIcon.astro using DOM nodes, not account HTML.
    for (const d of confirming
      ? ["m5 12 4 4L19 6"]
      : [
          "M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
          "m5 6 1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7m4-7v7",
        ]) {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", d);
      icon.appendChild(path);
    }
  };
  const resetDeleteConfirmation = () => {
    if (pendingDelete) showDeleteConfirmation(pendingDelete, false);
    pendingDelete = undefined;
  };
  const updateSteps = () => {
    const submitted = progress?.submittedAt != null;
    const naloxone = progress?.naloxoneCompletedAt != null;
    for (const button of steps) {
      const step = button.dataset.applicationStep;
      const completed =
        step === "form"
          ? submitted
          : step === "naloxone"
            ? naloxone
            : Boolean(progress?.applicationApproved);
      const available =
        step === "form" ||
        (step === "naloxone" ? submitted : submitted && naloxone);
      button.disabled = busy || !currentUserId || !available || completed;
      const status = button.querySelector<HTMLElement>("[data-step-status]");
      if (status) status.textContent = completed ? "Completed" : "";
    }
  };
  const setBusy = (value: boolean) => {
    busy = value;
    profiles.setAttribute("aria-busy", String(value));
    profiles
      .querySelectorAll<HTMLButtonElement>(
        "[data-switch-user], [data-delete-user]",
      )
      .forEach((button) => (button.disabled = value));
    createAccount?.setAttribute("aria-disabled", String(value));
    if (seedAccounts) seedAccounts.disabled = value;
    updateSteps();
  };
  setBusy(true);
  const trigger = document.querySelector<HTMLButtonElement>(
    "[data-open-account-switcher]",
  );
  const toggle = () => {
    if (root.open) root.close();
    else {
      root.showModal();
      trigger?.setAttribute("aria-expanded", "true");
    }
  };
  trigger?.addEventListener("click", toggle);
  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.code !== "KeyZ"
    )
      return;
    event.preventDefault();
    if (!event.repeat) toggle();
  });
  root
    .querySelector<HTMLButtonElement>("[data-close-account-switcher]")
    ?.addEventListener("click", () => root.close());
  root.addEventListener("close", () => {
    resetDeleteConfirmation();
    trigger?.setAttribute("aria-expanded", "false");
  });
  root.addEventListener("cancel", (event) => {
    if (!pendingDelete) return;
    event.preventDefault();
    resetDeleteConfirmation();
  });
  root.addEventListener("click", (event) => {
    if (pendingDelete && !event.composedPath().includes(pendingDelete))
      resetDeleteConfirmation();
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
  seedAccounts?.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    message.hidden = true;
    seedAccounts.textContent = "Seeding…";
    try {
      const result = await developmentAuthClient.dev.seedAccounts({});
      await refreshAccounts();
      message.textContent = result.message;
      message.hidden = false;
    } catch (error) {
      fail(error);
    } finally {
      seedAccounts.textContent = "Seed local accounts";
      setBusy(false);
    }
  });
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
  for (const button of steps)
    button.addEventListener("click", async () => {
      if (busy || button.disabled || !currentUserId) return;
      setBusy(true);
      message.hidden = true;
      try {
        const result = await developmentAuthClient.dev.applicationStep({
          userId: currentUserId,
          step: button.dataset.applicationStep as DevelopmentApplicationStep,
        });
        location.assign(result.next);
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
      if (pendingDelete !== button) {
        resetDeleteConfirmation();
        pendingDelete = button;
        showDeleteConfirmation(button, true);
        button.focus({ preventScroll: true });
        return;
      }
      resetDeleteConfirmation();
      setBusy(true);
      message.textContent = "Deleting local account…";
      message.hidden = false;
      try {
        const result = await developmentAuthClient.dev.deleteUser({
          userId: button.dataset.deleteUser,
          confirm: true,
        });
        if (result.next) {
          location.assign(result.next);
          return;
        }
        const row = button.closest("[data-local-account]");
        const nextFocus =
          row?.nextElementSibling?.querySelector<HTMLButtonElement>(
            "[data-delete-user]",
          ) ??
          row?.previousElementSibling?.querySelector<HTMLButtonElement>(
            "[data-delete-user]",
          ) ??
          seedAccounts;
        const panelBody = root.querySelector<HTMLElement>(".dialog-body");
        const scrollTop = panelBody?.scrollTop;
        row?.remove();
        if (emptyAccounts)
          emptyAccounts.hidden = accounts.childElementCount > 0;
        setBusy(false);
        message.textContent = "Local account deleted.";
        message.hidden = false;
        nextFocus?.focus({ preventScroll: true });
        if (panelBody && scrollTop !== undefined)
          panelBody.scrollTop = scrollTop;
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
  const refreshAccounts = async () => {
    const users: DevelopmentUser[] = [];
    let after: string | null = null;
    do {
      const result: DevelopmentUsers = await developmentAuthClient.dev.users({
        query: after ? { after } : {},
      });
      users.push(...result.users);
      after = result.next;
      currentUserId = result.currentUserId;
      progress = result.applicationProgress;
    } while (after);
    const personaOrder = new Map(
      manualAccountPresetIds.map((id, index) => [id, index]),
    );
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
    states
      .querySelectorAll("[data-account-category]")
      .forEach((group) => group.remove());
    const groups = new Map(
      manualAccountGroups.map((group) => {
        const section = document.createElement("section");
        section.className = "account-state-category";
        section.dataset.accountCategory = group.key;
        const heading = document.createElement("h4");
        const buttons = document.createElement("div");
        buttons.className = "account-profile-buttons";
        buttons.setAttribute("role", "group");
        buttons.setAttribute("aria-label", group.label);
        section.appendChild(heading);
        section.appendChild(buttons);
        states.appendChild(section);
        return [
          group.key,
          { section, heading, buttons, label: group.label },
        ] as const;
      }),
    );
    accounts.replaceChildren();
    groups
      .get("application")!
      .buttons.appendChild(
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
        manualAccountPresets.find(({ id }) => id === user.id)?.label ?? label,
        `${user.email}${user.role === "organizer" ? " · Organizer" : ""} · ${developmentAccountStatus(user.state)}`,
      );
      const preset = manualAccountPresets.find(({ id }) => id === user.id);
      if (preset) {
        groups.get(preset.group)!.buttons.appendChild(button);
        continue;
      }
      const row = document.createElement("div");
      row.className =
        "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2";
      row.dataset.localAccount = user.id;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-quiet account-profile-delete";
      remove.dataset.deleteUser = user.id;
      remove.dataset.deleteName = `${label} (${user.email})`;
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      for (const [name, value] of Object.entries({
        class: "size-5",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
        focusable: "false",
      }))
        icon.setAttribute(name, value);
      remove.appendChild(icon);
      showDeleteConfirmation(remove, false);
      remove.addEventListener("blur", () => {
        if (pendingDelete === remove) resetDeleteConfirmation();
      });
      row.appendChild(button);
      row.appendChild(remove);
      accounts.appendChild(row);
    }
    for (const { section, heading, buttons, label } of groups.values()) {
      section.hidden = buttons.childElementCount === 0;
      heading.textContent = `${label} (${buttons.childElementCount})`;
    }
    if (emptyAccounts) emptyAccounts.hidden = accounts.childElementCount > 0;
    const current = users.find((user) => user.id === currentUserId);
    if (stepAccount)
      stepAccount.textContent = current
        ? `Current account: ${current.name || current.email}`
        : "Choose an account to use these shortcuts.";
    profiles
      .querySelectorAll<HTMLButtonElement>("[data-switch-user]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.switchUser === (currentUserId ?? "")),
        ),
      );
  };
  try {
    await refreshAccounts();
  } catch (error) {
    fail(error);
  } finally {
    setBusy(false);
  }
}
