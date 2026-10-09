import { vancouverInstant } from "../data/event-time";
import { actionFragment, loadActionPage } from "./action-page";
import { chooseNotification } from "./notification-choice";

// Compare against the server HTML, not transient loading/filter/expanded state.
const renderedCards = new WeakMap<HTMLElement, string>();
let deferredEventRefresh = false;
let refreshDeferredEvents = () => {};
for (const card of document.querySelectorAll<HTMLElement>("[data-live-event]"))
  renderedCards.set(card, card.outerHTML);

function applyEventFilter(root: HTMLElement, type: string) {
  const selected = ["patrol", "orientation"].includes(type) ? type : "all";
  let visible = 0;
  for (const card of root.querySelectorAll<HTMLElement>("[data-event-type]")) {
    card.hidden = selected !== "all" && card.dataset.eventType !== selected;
    if (!card.hidden) visible++;
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-event-filter]",
  ))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.eventFilter === selected),
    );
  const empty = root.querySelector<HTMLElement>("[data-empty-events]");
  if (empty) empty.hidden = visible !== 0;
}

document
  .querySelectorAll<HTMLElement>("[data-event-browser]")
  .forEach((root) => {
    const filters = root.querySelectorAll<HTMLButtonElement>(
      "[data-event-filter]",
    );
    const applyFilter = (type: string) => applyEventFilter(root, type);
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

function syncNotifications(page: Document) {
  const target = document.querySelector<HTMLElement>(
    "[data-event-notifications]",
  );
  if (target)
    target.replaceWith(actionFragment(page, "[data-event-notifications]"));
}

function syncEvents(page: Document, element?: HTMLFormElement) {
  const root = document.querySelector<HTMLElement>("[data-event-browser]");
  if (!root) return;
  // Reuse server rendering for authoritative capacity, eligibility, rosters,
  // destination options and optimistic edit versions.
  const refreshed = actionFragment(page, "[data-event-browser]");
  deferredEventRefresh = false;
  const list = root.querySelector<HTMLElement>("[data-event-list]")!;
  const previous = new Map(
    [...list.querySelectorAll<HTMLElement>("[data-live-event]")].map((card) => [
      card.dataset.liveEvent!,
      card,
    ]),
  );
  const focused = document.activeElement;
  const focusedCard =
    focused instanceof HTMLElement
      ? focused.closest<HTMLElement>("[data-live-event]")
      : null;
  const eventId =
    element?.closest<HTMLElement>("[data-live-event]")?.dataset.liveEvent ??
    focusedCard?.dataset.liveEvent;
  const dialog = element?.closest<HTMLDialogElement>("dialog");
  const restoreFocus = Boolean(
    element
      ? element.contains(focused) ||
          dialog?.contains(focused) ||
          focused === document.body
      : focusedCard,
  );
  dialog?.close();
  let added: HTMLElement | undefined;
  let position = list.firstElementChild;
  for (const updated of refreshed.querySelectorAll<HTMLElement>(
    "[data-live-event]",
  )) {
    const id = updated.dataset.liveEvent!;
    let card = previous.get(id);
    previous.delete(id);
    // Don't discard an unrelated editor's draft or another action in flight.
    const protectedCard =
      card &&
      (card.querySelector("dialog[open]") ||
        [
          ...card.querySelectorAll<HTMLFormElement>(
            'form[data-submitting="true"]',
          ),
        ].some((form) => form !== element));
    if (
      card &&
      protectedCard &&
      renderedCards.get(card) !== updated.outerHTML
    ) {
      deferredEventRefresh = true;
      // A live count must not overwrite an open editor or an in-flight signup.
      const availability = card.querySelector("[data-event-availability]");
      const nextAvailability = updated.querySelector(
        "[data-event-availability]",
      );
      if (availability && nextAvailability)
        availability.replaceWith(document.importNode(nextAvailability, true));
    }
    if (
      !card ||
      (!protectedCard && renderedCards.get(card) !== updated.outerHTML)
    ) {
      const replacement = document.importNode(updated, true);
      renderedCards.set(replacement, updated.outerHTML);
      const roster =
        replacement.querySelector<HTMLDetailsElement>(".volunteer-roster");
      if (roster)
        roster.open =
          card?.querySelector<HTMLDetailsElement>(".volunteer-roster")?.open ??
          false;
      if (card) {
        if (position === card) position = replacement;
        card.replaceWith(replacement);
      } else added ??= replacement;
      card = replacement;
    }
    if (card !== position) list.insertBefore(card, position);
    position = card.nextElementSibling;
  }
  for (const card of previous.values()) card.remove();
  for (const selector of ["[data-empty-events]", "[data-event-limit]"]) {
    const target = root.querySelector(selector);
    if (target) target.replaceWith(actionFragment(page, selector));
  }
  applyEventFilter(
    root,
    new URL(location.href).searchParams.get("type") ?? "all",
  );
  root.dataset.eventVersion = refreshed.dataset.eventVersion;
  if (element?.matches("[data-event-save]") && !eventId) element.reset();
  if (restoreFocus && (element || !focused?.isConnected)) {
    const card = eventId
      ? [...list.querySelectorAll<HTMLElement>("[data-live-event]")].find(
          (card) => card.dataset.liveEvent === eventId,
        )
      : added;
    const selector =
      element?.matches("[data-live-signup]") ||
      (!element && focused?.closest("[data-live-signup]"))
        ? '[data-live-signup] button[type="submit"]'
        : element?.matches("[data-event-save]")
          ? "[data-show-dialog]"
          : !element &&
              focused instanceof HTMLElement &&
              focused.dataset.showDialog
            ? `[data-show-dialog="${CSS.escape(focused.dataset.showDialog)}"]`
            : ".volunteer-roster summary";
    (card && !card.hidden
      ? card.querySelector<HTMLElement>(selector)
      : null
    )?.focus({ preventScroll: true });
    if (document.activeElement === document.body)
      root
        .querySelector<HTMLElement>('[data-event-filter][aria-pressed="true"]')
        ?.focus({ preventScroll: true });
  }
}

async function refreshEvents(element: HTMLFormElement) {
  const page = await loadActionPage();
  syncEvents(page, element);
  syncNotifications(page);
}

async function refreshNotifications(element: HTMLFormElement) {
  const restoreFocus =
    element.contains(document.activeElement) ||
    document.activeElement === document.body;
  syncNotifications(await loadActionPage());
  if (restoreFocus)
    document
      .querySelector<HTMLElement>("[data-retry-notifications] button")
      ?.focus({ preventScroll: true });
}

async function refreshVolunteer(element: HTMLFormElement) {
  const userId = element.querySelector<HTMLInputElement>(
    'input[name="userId"]',
  )!.value;
  const profile = element.closest<HTMLElement>("[data-volunteer-profile]")!;
  const hostUrl = location.href;
  const profileUrl = `/volunteer/volunteers/${encodeURIComponent(userId)}`;
  const onProfilePage = location.pathname === profileUrl;
  const [page, host] = await Promise.all([
    loadActionPage(profileUrl),
    onProfilePage ? Promise.resolve(null) : loadActionPage(hostUrl),
  ]);
  const replacement = actionFragment(page, "[data-volunteer-profile]");
  // Keep the dialog itself (and its scroll position) open; replace all status
  // forms together so their versions and hidden checkbox values stay in sync.
  const dialog = element.closest<HTMLDialogElement>("dialog");
  const scroll = dialog?.scrollTop;
  const active = document.activeElement;
  const restoreFocus = element.contains(active) || active === document.body;
  const selector = element.matches("[data-organizer-role]")
    ? '[data-organizer-role] select[name="role"]'
    : element.hasAttribute("data-submit-on-change")
      ? '[data-organizer-status][data-submit-on-change] input[name="active"]'
      : '[data-organizer-status]:not([data-submit-on-change]) button[type="submit"]';
  if (profile.isConnected && (!dialog || dialog.open)) {
    profile.replaceWith(replacement);
    if (dialog && scroll !== undefined) dialog.scrollTop = scroll;
    if (restoreFocus)
      replacement
        .querySelector<HTMLElement>(selector)
        ?.focus({ preventScroll: true });
  }
  if (host && location.href === hostUrl) {
    const results = document.querySelector<HTMLElement>(
      "[data-volunteer-results]",
    );
    if (results)
      results.replaceChildren(
        ...actionFragment(host, "[data-volunteer-results]").childNodes,
      );
    syncEvents(host);
    syncNotifications(host);
  }
}

interface Result {
  message?: string;
  localNotifications?: { to: string; subject: string; body: string }[];
}
let pendingRefresh = Promise.resolve();

const eventBrowser = document.querySelector<HTMLElement>(
  "[data-event-browser]",
);
if (eventBrowser && "EventSource" in window) {
  let source: EventSource | undefined;
  let liveRefreshQueued = false;
  const refreshLiveEvents = () => {
    if (liveRefreshQueued || document.hidden) return;
    liveRefreshQueued = true;
    // Share the action refresh queue so an older SSE-triggered GET cannot undo
    // a newer signup, and coalesce notifications while a GET is in flight.
    const refresh = pendingRefresh.then(async () => {
      if (document.hidden) return;
      const page = await loadActionPage();
      if (!document.hidden) syncEvents(page);
    });
    pendingRefresh = refresh.catch(() => {});
    void pendingRefresh.finally(() => {
      liveRefreshQueued = false;
    });
  };
  refreshDeferredEvents = refreshLiveEvents;
  const disconnect = () => {
    source?.close();
    source = undefined;
  };
  const connect = () => {
    if (source || document.hidden) return;
    const current = new EventSource("/api/v1/events/stream");
    source = current;
    current.addEventListener("events", (event) => {
      if (source !== current) return;
      const data = (event as MessageEvent<string>).data;
      if (!/^"[a-f0-9]{64}"$/.test(data)) return;
      const version: string = JSON.parse(data);
      if (version !== eventBrowser.dataset.eventVersion) refreshLiveEvents();
    });
  };
  document.addEventListener("visibilitychange", () =>
    document.hidden ? disconnect() : connect(),
  );
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("pageshow", connect);
  document.addEventListener(
    "close",
    (event) => {
      if (
        deferredEventRefresh &&
        event.target instanceof HTMLDialogElement &&
        event.target.closest("[data-live-event]")
      )
        refreshLiveEvents();
    },
    true,
  );
  connect();
}

function form(
  selector: string,
  endpoint: string,
  body: (values: FormData) => object,
  complete: (element: HTMLFormElement) => Promise<void> = refreshEvents,
) {
  document.addEventListener("submit", async (event) => {
    const element = event.target;
    if (!(element instanceof HTMLFormElement) || !element.matches(selector))
      return;
    event.preventDefault();
    const scope =
      element.closest<HTMLElement>("[data-volunteer-controls], dialog") ??
      element;
    if (scope.dataset.submitting) return;
    const button = element.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (button?.disabled) return;
    const focused = document.activeElement;
    element.dataset.submitting = "true";
    scope.dataset.submitting = "true";
    const values = new FormData(element);
    const controls = [
      ...scope.querySelectorAll<HTMLElement & { disabled: boolean }>(
        'input:not([type="hidden"]), select, textarea, button',
      ),
    ].filter((control) => !control.disabled);
    for (const control of controls) control.disabled = true;
    const loading = element.querySelector<HTMLElement>("[data-action-loading]");
    const label = button?.textContent;
    const message = element.querySelector<HTMLElement>("[data-form-message]");
    if (message) {
      message.hidden = true;
      message.textContent = "";
    }
    let saved = false;
    try {
      let notify: boolean | undefined;
      if (element.dataset.emailPrompt) {
        const choice = await chooseNotification(element.dataset.emailPrompt);
        if (choice === null) {
          if (element.hasAttribute("data-submit-on-change")) element.reset();
          return;
        }
        notify = choice;
      }
      element.setAttribute("aria-busy", "true");
      if (loading) loading.hidden = false;
      if (button?.dataset.loadingLabel) {
        button.textContent = button.dataset.loadingLabel;
        button.setAttribute("aria-busy", "true");
      }
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body(values),
          ...(notify === undefined ? {} : { notify }),
        }),
      });
      const result: Result = await response.json();
      if (!response.ok)
        throw new Error(result.message || "The change could not be saved.");
      saved = true;
      if (import.meta.env.DEV && result.localNotifications?.length) {
        const { chooseEmailOutcome } =
          await import("../dev/scripts/local-email-dialog");
        await chooseEmailOutcome(result.localNotifications, true);
      }
      // Writes may run concurrently, but each refresh must fetch and apply after
      // the previous one. Otherwise a slower, older response can undo newer UI.
      const refresh = pendingRefresh.then(() => complete(element));
      pendingRefresh = refresh.catch(() => {});
      await refresh;
    } catch (error) {
      // Failed automatic toggles must not look like committed settings.
      if (!saved && element.hasAttribute("data-submit-on-change"))
        element.reset();
      if (message) {
        message.setAttribute("role", "alert");
        message.dataset.messageKind = "error";
        message.textContent =
          error instanceof Error
            ? error.message
            : "The change could not be saved.";
        message.hidden = false;
      }
    } finally {
      for (const control of controls) control.disabled = false;
      if (button) {
        button.removeAttribute("aria-busy");
        if (button.dataset.loadingLabel) button.textContent = label ?? "";
      }
      element.removeAttribute("aria-busy");
      if (loading) loading.hidden = true;
      delete element.dataset.submitting;
      delete scope.dataset.submitting;
      if (!saved && deferredEventRefresh && !element.closest("dialog[open]"))
        refreshDeferredEvents();
      if (
        !saved &&
        focused instanceof HTMLElement &&
        focused.isConnected &&
        (document.activeElement === document.body ||
          document.activeElement === element.closest("dialog"))
      )
        focused.focus({ preventScroll: true });
    }
  });
}
const str = (values: FormData, key: string) => String(values.get(key) ?? "");
form("[data-live-signup]", "/api/v1/events/action", (v) => ({
  action: str(v, "action"),
  id: str(v, "id"),
}));
form("[data-event-save]", "/api/v1/events/action", (v) => ({
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
    open: str(v, "open") === "true",
    hidden: str(v, "hidden") === "true",
  },
}));
form("[data-event-cancel]", "/api/v1/events/action", (v) => ({
  action: "cancel-event",
  id: str(v, "id"),
  version: Number(v.get("version")),
  reason: str(v, "reason"),
}));
form("[data-manage-signup]", "/api/v1/events/action", (v) => ({
  action: "manage-signup",
  id: str(v, "id"),
  ...(v.get("destination") ? { destination: str(v, "destination") } : {}),
  reason: str(v, "reason"),
}));
form(
  "[data-retry-notifications]",
  "/api/v1/events/action",
  () => ({
    action: "retry-notifications",
  }),
  refreshNotifications,
);
form(
  "[data-organizer-status]",
  "/api/v1/organizer/action",
  (v) => ({
    action: "status",
    userId: str(v, "userId"),
    version: Number(v.get("version")),
    active: v.has("active"),
    patrolApproved: v.has("patrolApproved"),
  }),
  refreshVolunteer,
);
form(
  "[data-organizer-role]",
  "/api/v1/organizer/action",
  (v) => ({
    action: "role",
    userId: str(v, "userId"),
    role: str(v, "role"),
  }),
  refreshVolunteer,
);
form("[data-organizer-orientation]", "/api/v1/organizer/action", (v) => ({
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
  const loadingTemplate = profileDialog.querySelector<HTMLTemplateElement>(
    "[data-profile-dialog-loading]",
  );
  let pending: AbortController | undefined;
  profileDialog.addEventListener("close", () => {
    pending?.abort();
    pending = undefined;
    profileContent.replaceChildren();
    profileContent.removeAttribute("aria-busy");
    profileDialog.scrollTop = 0;
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
    if (loadingTemplate)
      profileContent.replaceChildren(loadingTemplate.content.cloneNode(true));
    else profileContent.textContent = "Loading";
    profileContent.setAttribute("aria-busy", "true");
    profileDialog.scrollTop = 0;
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
      if (!controller.signal.aborted && profileDialog.open) {
        const loading = profileContent.querySelector<HTMLElement>(
          ".volunteer-profile-loading",
        );
        const loadingHeight = profileContent.clientHeight;
        const profile = document.importNode(content, true);
        const animate = !window.matchMedia("(prefers-reduced-motion: reduce)")
          .matches;
        if (animate) {
          profile.setAttribute("data-profile-entering", "");
          const finishEntering = (event: Event) => {
            if (event.target === profile)
              profile.removeAttribute("data-profile-entering");
          };
          profile.addEventListener("animationend", finishEntering, {
            once: true,
          });
          profile.addEventListener("animationcancel", finishEntering, {
            once: true,
          });
        }
        profileContent.replaceChildren(profile);
        if (loading && animate) {
          // Keep the outgoing loader in place as the full profile grows below it.
          loading.style.height = `${loadingHeight}px`;
          loading.style.bottom = "auto";
          loading.setAttribute("aria-hidden", "true");
          loading.dataset.fading = "true";
          const removeLoading = (event: Event) => {
            if (event.target === loading) loading.remove();
          };
          loading.addEventListener("animationend", removeLoading, {
            once: true,
          });
          loading.addEventListener("animationcancel", removeLoading, {
            once: true,
          });
          profileContent.appendChild(loading);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted)
        profileContent.textContent =
          error instanceof Error
            ? error.message
            : "The volunteer profile is unavailable.";
    } finally {
      if (pending === controller) profileContent.removeAttribute("aria-busy");
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

document.addEventListener("click", (event) => {
  const dialog = event.target;
  if (
    !(dialog instanceof HTMLDialogElement) ||
    !dialog.matches(".volunteer-dialog")
  )
    return;
  const bounds = dialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    dialog.close();
});
