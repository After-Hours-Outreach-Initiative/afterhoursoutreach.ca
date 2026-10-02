interface DevelopmentUser {
  id: string;
  name: string;
  email: string;
  role: "volunteer" | "organizer";
}

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
        const response = await fetch("/api/auth/sign-out", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!response.ok) throw new Error("Could not end the current session.");
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
      const response = await fetch(
        `/api/auth/dev/users${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        {
          credentials: "same-origin",
        },
      );
      if (!response.ok)
        throw new Error(
          "Could not load local accounts. Check your local database migrations and auth secret.",
        );
      const result: {
        users: DevelopmentUser[];
        next: string | null;
        currentUserId: string | null;
      } = await response.json();
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
        const response = await fetch("/api/auth/dev/switch-user", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: select.value || null,
            returnTo: location.pathname + location.search,
          }),
        });
        const result: { next?: string; message?: string } =
          await response.json();
        if (!response.ok)
          throw new Error(result.message || "Could not switch accounts.");
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
