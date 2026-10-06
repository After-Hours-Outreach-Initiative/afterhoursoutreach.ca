import { vancouverInstant } from "../data/event-time";

document
  .querySelectorAll<HTMLElement>("[data-event-browser]")
  .forEach((root) => {
    const cards = root.querySelectorAll<HTMLElement>("[data-event-type]");
    const filters = root.querySelectorAll<HTMLButtonElement>(
      "[data-event-filter]",
    );
    const empty = root.querySelector<HTMLElement>("[data-empty-events]");
    const applyFilter = (type: string) => {
      const selected = ["patrol", "orientation"].includes(type) ? type : "all";
      let visible = 0;
      for (const card of cards) {
        card.hidden = selected !== "all" && card.dataset.eventType !== selected;
        if (!card.hidden) visible++;
      }
      for (const button of filters)
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.eventFilter === selected),
        );
      if (empty) empty.hidden = visible !== 0;
    };
    for (const button of filters)
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const type = button.dataset.eventFilter ?? "all";
        applyFilter(type);
        const url = new URL(location.href);
        if (type === "all") url.searchParams.delete("type");
        else url.searchParams.set("type", type);
        history.pushState(null, "", url);
      });
    window.addEventListener("popstate", () =>
      applyFilter(new URL(location.href).searchParams.get("type") ?? "all"),
    );
  });

interface Result {
  message?: string;
  failed?: number;
}
function form(
  selector: string,
  endpoint: string,
  body: (values: FormData) => object,
) {
  document.addEventListener("submit", async (event) => {
    const element = event.target;
    if (!(element instanceof HTMLFormElement) || !element.matches(selector))
      return;
    event.preventDefault();
    if (element.dataset.submitting) return;
    const button = element.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (button?.disabled) return;
    element.dataset.submitting = "true";
    const values = new FormData(element);
    if (button) button.disabled = true;
    const message = element.querySelector<HTMLElement>("[data-form-message]");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body(values)),
      });
      const result: Result = await response.json();
      if (!response.ok)
        throw new Error(result.message || "The change could not be saved.");
      const notice = result.message ?? "Saved.";
      sessionStorage.setItem("aho-volunteer-notice", notice);
      location.reload();
    } catch (error) {
      if (message) {
        message.textContent =
          error instanceof Error
            ? error.message
            : "The change could not be saved.";
        message.hidden = false;
      }
    } finally {
      if (button) button.disabled = false;
      delete element.dataset.submitting;
    }
  });
}
const str = (values: FormData, key: string) => String(values.get(key) ?? "");
form("[data-live-signup]", "/api/events/action", (v) => ({
  action: str(v, "action"),
  id: str(v, "id"),
}));
form("[data-event-save]", "/api/events/action", (v) => ({
  action: "save",
  ...(v.has("id")
    ? { id: str(v, "id"), version: Number(v.get("version")) }
    : {}),
  event: {
    type: str(v, "type"),
    startsAt: vancouverInstant(str(v, "startsAt")),
    meetingPoint: str(v, "meetingPoint"),
    meetingPointUrl: str(v, "meetingPointUrl"),
    spots: Number(v.get("spots")),
    open: v.has("open"),
    hidden: v.has("hidden"),
  },
}));
form("[data-event-cancel]", "/api/events/action", (v) => ({
  action: "cancel-event",
  id: str(v, "id"),
  version: Number(v.get("version")),
  reason: str(v, "reason"),
}));
form("[data-manage-signup]", "/api/events/action", (v) => ({
  action: "manage-signup",
  id: str(v, "id"),
  ...(v.get("destination") ? { destination: str(v, "destination") } : {}),
  reason: str(v, "reason"),
}));
form("[data-retry-notifications]", "/api/events/action", () => ({
  action: "retry-notifications",
}));
form("[data-organizer-status]", "/api/organizer/action", (v) => ({
  action: "status",
  userId: str(v, "userId"),
  version: Number(v.get("version")),
  active: v.has("active"),
  patrolApproved: v.has("patrolApproved"),
}));
form("[data-organizer-role]", "/api/organizer/action", (v) => ({
  action: "role",
  userId: str(v, "userId"),
  role: str(v, "role"),
}));
form("[data-organizer-orientation]", "/api/organizer/action", (v) => ({
  action: "orientation",
  userId: str(v, "userId"),
  eventId: str(v, "eventId"),
}));
document.addEventListener("change", (event) => {
  if (!(event.target instanceof Element)) return;
  event.target
    .closest<HTMLFormElement>("form[data-submit-on-change]")
    ?.requestSubmit();
});
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>(
    "[data-show-dialog], [data-dismiss-dialog]",
  );
  if (button?.hasAttribute("data-dismiss-dialog"))
    button.closest<HTMLDialogElement>("dialog")?.close();
  else if (button) {
    const dialog = document.getElementById(button.dataset.showDialog ?? "");
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  }
});

const profileDialog = document.querySelector<HTMLDialogElement>(
  "[data-volunteer-profile-dialog]",
);
const profileContent = profileDialog?.querySelector<HTMLElement>(
  "[data-profile-dialog-content]",
);
if (profileDialog && profileContent) {
  let pending: AbortController | undefined;
  profileDialog.addEventListener("close", () => {
    pending?.abort();
    profileContent.replaceChildren();
  });
  document.addEventListener("click", async (event) => {
    if (
      !(event.target instanceof Element) ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target.closest<HTMLAnchorElement>(
      "[data-volunteer-profile-link]",
    );
    if (!link) return;
    event.preventDefault();
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    profileContent.textContent = "Loading volunteer profile…";
    profileDialog.showModal();
    try {
      // The normal private page still authenticates, checks organizer access,
      // and records the profile view before returning any answers.
      const response = await fetch(link.href, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected)
        throw new Error(
          "Could not load the profile. Check your organizer session and try again.",
        );
      const page = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      const content = page.querySelector("[data-volunteer-profile]");
      if (!content) throw new Error("The volunteer profile is unavailable.");
      if (!controller.signal.aborted && profileDialog.open)
        profileContent.replaceChildren(document.importNode(content, true));
    } catch (error) {
      if (!controller.signal.aborted)
        profileContent.textContent =
          error instanceof Error
            ? error.message
            : "The volunteer profile is unavailable.";
    }
  });
}

document
  .querySelectorAll<HTMLElement>("[data-volunteer-browser]")
  .forEach((root) => {
    const search = root.querySelector<HTMLInputElement>(
      "[data-volunteer-search]",
    );
    const form = root.querySelector<HTMLFormElement>(
      "[data-volunteer-search-form]",
    );
    const results = root.querySelector<HTMLElement>("[data-volunteer-results]");
    const error = root.querySelector<HTMLElement>(
      "[data-volunteer-search-error]",
    );
    if (!search || !form || !results || !error) return;
    let timer: number;
    let pending: AbortController | undefined;
    const loadResults = async () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const url = new URL(location.href);
      if (search.value) url.searchParams.set("q", search.value);
      else url.searchParams.delete("q");
      url.searchParams.delete("offset");
      results.setAttribute("aria-busy", "true");
      error.hidden = true;
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected)
          throw new Error(
            "Could not search volunteers. Check your organizer session.",
          );
        const page = new DOMParser().parseFromString(
          await response.text(),
          "text/html",
        );
        const updated = page.querySelector("[data-volunteer-results]");
        if (!updated) throw new Error("Volunteer search is unavailable.");
        if (!controller.signal.aborted) {
          results.replaceChildren(
            ...Array.from(updated.childNodes, (node) =>
              document.importNode(node, true),
            ),
          );
          history.replaceState(null, "", url);
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          error.textContent =
            reason instanceof Error
              ? reason.message
              : "Volunteer search is unavailable.";
          error.hidden = false;
        }
      } finally {
        if (!controller.signal.aborted) results.removeAttribute("aria-busy");
      }
    };
    search.addEventListener("input", () => {
      clearTimeout(timer);
      pending?.abort();
      timer = window.setTimeout(() => void loadResults(), 180);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      clearTimeout(timer);
      void loadResults();
    });
  });

document
  .querySelectorAll<HTMLDialogElement>(".volunteer-dialog")
  .forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        dialog.close();
    });
  });
const notice = sessionStorage.getItem("aho-volunteer-notice");
const target = document.querySelector<HTMLElement>("[data-action-notice]");
if (notice && target) {
  target.textContent = notice;
  target.hidden = false;
  sessionStorage.removeItem("aho-volunteer-notice");
}
