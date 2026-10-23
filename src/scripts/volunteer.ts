import { vancouverInstant } from "../data/event-time";
import { eventFilter, matchesEventFilter } from "../data/event-browser";
import { handleEventCalendarClick, syncEventCalendar } from "./event-calendar";
import { actionFragment, loadActionPage } from "./action-page";
import { syncApplicationProgress } from "./application-progress";
import { focusAfterUpdate } from "./focus";
import { chooseNotification } from "./notification-choice";
import { confirmEventDeletion } from "./event-deletion";
import { initDateInputs, readDateInputs } from "./date-input";
import {
  initRecurrenceControls,
  recurringSaveAction,
  recurringCancelAction,
  seriesSaveAction,
  syncSeriesControls,
  eventEmailPrompt,
} from "./event-recurrence";
import {
  cancelVolunteerSearch,
  initVolunteerBrowser,
  syncVolunteerBrowser,
} from "./volunteer-browser";
import {
  actionEmailNeedsFeedback,
  showActionEmailFeedback,
  simulateActionEmail,
  type EmailActionResult,
} from "./action-email-feedback";

function submitButton(form: HTMLFormElement) {
  // Native form ownership also includes buttons in the persistent dialog footer.
  return Array.from(form.elements).find(
    (control): control is HTMLButtonElement =>
      control instanceof HTMLButtonElement && control.type === "submit",
  );
}

function initEventDates(root: Document | HTMLElement) {
  initDateInputs(root);
  initRecurrenceControls(root);
  for (const form of root.querySelectorAll<HTMLFormElement>(
    "[data-event-save]:not([data-submitting]), [data-series-save]:not([data-submitting])",
  )) {
    const button = submitButton(form);
    if (button) button.disabled = false;
    for (const step of form.querySelectorAll<HTMLButtonElement>(
      "[data-spots-step]",
    ))
      step.disabled = false;
  }
}
// Compare against the server HTML, not transient loading/filter/expanded state.
const renderedCards = new WeakMap<HTMLElement, string>();
let deferredEventRefresh = false;
let refreshDeferredEvents = () => {};
for (const card of document.querySelectorAll<HTMLElement>("[data-live-event]"))
  renderedCards.set(card, card.outerHTML);
initEventDates(document);

function applyEventFilter(root: HTMLElement, type: string) {
  const selected = eventFilter(type, root.dataset.eventView === "manage");
  let visible = 0;
  for (const card of root.querySelectorAll<HTMLElement>(
    "[data-event-list] > [data-live-event], [data-event-list] > [data-series-card]",
  )) {
    card.hidden = !matchesEventFilter(
      selected,
      Boolean(card.dataset.seriesCard),
      card.dataset.includesOrientation === "true",
    );
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
  syncEventCalendar(root);
}

document
  .querySelectorAll<HTMLElement>("[data-event-browser]")
  .forEach((root) => {
    const applyFilter = (type: string) => applyEventFilter(root, type);
    syncEventCalendar(root);
    root.addEventListener("click", (event) => {
      handleEventCalendarClick(root, event);
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>(
        "[data-event-filter]",
      );
      if (!button) return;
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

function syncEvents(page: Document, element?: HTMLFormElement) {
  const root = document.querySelector<HTMLElement>("[data-event-browser]");
  if (!root) return;
  // Reuse server rendering for authoritative capacity, eligibility, rosters,
  // destination options and optimistic edit versions.
  const refreshed = actionFragment(page, "[data-event-browser]");
  // Approval and course completion can change the canonical portal destination.
  // Keep the existing menus/listeners and polling state while adopting server UI.
  if (/^\/(?:events|volunteer)\/?$/.test(location.pathname)) {
    const nextLink = page.querySelector<HTMLAnchorElement>(
      "[data-volunteer-nav]",
    );
    if (nextLink) {
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        "[data-volunteer-nav]",
      )) {
        link.setAttribute("href", nextLink.getAttribute("href")!);
        link.querySelector("[data-volunteer-nav-label]")!.textContent =
          nextLink.querySelector("[data-volunteer-nav-label]")!.textContent;
        if (nextLink.hasAttribute("aria-current"))
          link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    }
    const heading = document.querySelector("[data-portal-heading]");
    if (heading && page.querySelector("[data-portal-heading]"))
      heading.replaceWith(actionFragment(page, "[data-portal-heading]"));
    document.title = page.title;
    if (refreshed.dataset.eventPath) {
      const url = new URL(location.href);
      url.pathname = refreshed.dataset.eventPath;
      if (url.href !== location.href) history.replaceState(null, "", url);
    }
  }
  root.dataset.applicationAwaitingApproval =
    refreshed.dataset.applicationAwaitingApproval;
  deferredEventRefresh = false;
  if (root.dataset.eventAccess !== refreshed.dataset.eventAccess) {
    const restoreFocus = root.contains(document.activeElement);
    root.replaceChildren(...refreshed.childNodes);
    root.dataset.eventAccess = refreshed.dataset.eventAccess;
    root.dataset.eventVersion = refreshed.dataset.eventVersion;
    for (const card of root.querySelectorAll<HTMLElement>("[data-live-event]"))
      renderedCards.set(card, card.outerHTML);
    applyEventFilter(
      root,
      new URL(location.href).searchParams.get("type") ?? "all",
    );
    initEventDates(root);
    if (restoreFocus)
      focusAfterUpdate(
        root.querySelector('[aria-current="step"] summary, #events-heading') ??
          document.querySelector("[data-portal-heading]"),
      );
    document.dispatchEvent(new Event("account-content-updated"));
    return;
  }
  if (root.dataset.eventAccess !== "true") {
    const tracker = root.querySelector("[data-application-tracker]");
    const nextTracker = refreshed.querySelector("[data-application-tracker]");
    if (tracker && nextTracker) {
      // Pending portal chrome (such as the inactive notice) is authoritative,
      // but keep the tracker attached so unchanged controls never lose focus.
      const children = [...refreshed.children];
      for (const child of [...root.children])
        if (
          child !== tracker &&
          !children.some((updated) => updated.outerHTML === child.outerHTML)
        )
          child.remove();
      let position = root.firstElementChild;
      for (const updated of children) {
        if (updated === nextTracker) position = tracker.nextElementSibling;
        else if (position?.outerHTML === updated.outerHTML)
          position = position.nextElementSibling;
        else root.insertBefore(document.importNode(updated, true), position);
      }
      syncApplicationProgress(page);
    } else root.replaceChildren(...refreshed.childNodes);
    root.dataset.eventVersion = refreshed.dataset.eventVersion;
    document.dispatchEvent(new Event("account-content-updated"));
    return;
  }
  syncApplicationProgress(page);
  const list = root.querySelector<HTMLElement>("[data-event-list]")!;
  const focused = document.activeElement;
  const focusedCard =
    focused instanceof HTMLElement
      ? focused.closest<HTMLElement>("[data-live-event]")
      : null;
  const eventId =
    element?.closest<HTMLElement>("[data-live-event]")?.dataset.liveEvent ??
    focusedCard?.dataset.liveEvent;
  const focusedSeries =
    focused instanceof HTMLElement
      ? focused.closest<HTMLElement>("[data-series-card]")
      : null;
  const seriesId =
    element?.closest<HTMLElement>("[data-series-card]")?.dataset.seriesCard ??
    focusedSeries?.dataset.seriesCard;
  const focusedSeriesSummary = focused?.matches(
    "[data-series-occurrences] > summary",
  )
    ? "[data-series-occurrences] > summary"
    : focused?.matches("[data-live-series] > summary")
      ? "[data-live-series] > summary"
      : null;
  const focusedEventSummary = [
    ".volunteer-roster > summary",
    ".public-event-roster > summary",
  ].find((selector) => focused?.matches(selector));
  const dialog = element?.closest<HTMLDialogElement>("dialog");
  const restoreFocus = Boolean(
    element
      ? element.contains(focused) ||
          dialog?.contains(focused) ||
          focused === document.body
      : focusedCard || focusedSeries,
  );
  dialog?.close();
  let added: HTMLElement | undefined;
  const protectedEvent = (card: HTMLElement) =>
    Boolean(
      card.querySelector("dialog[open]") ||
      [
        ...card.querySelectorAll<HTMLFormElement>(
          'form[data-submitting="true"]',
        ),
      ].some((form) => form !== element),
    );
  const key = (card: HTMLElement) =>
    card.dataset.seriesCard
      ? `series:${card.dataset.seriesCard}`
      : `event:${card.dataset.liveEvent}`;
  const syncList = (list: HTMLElement, nextList: HTMLElement) => {
    const previous = new Map(
      [...list.children]
        .filter((card): card is HTMLElement => card instanceof HTMLElement)
        .map((card) => [key(card), card]),
    );
    let position = list.firstElementChild;
    for (const updated of nextList.children) {
      if (!(updated instanceof HTMLElement)) continue;
      const id = key(updated);
      let card = previous.get(id);
      previous.delete(id);
      if (updated.dataset.seriesCard) {
        if (!card) {
          card = document.importNode(updated, true);
          for (const occurrence of card.querySelectorAll<HTMLElement>(
            "[data-live-event]",
          ))
            renderedCards.set(occurrence, occurrence.outerHTML);
          added ??= card;
        } else {
          card.dataset.includesOrientation =
            updated.dataset.includesOrientation;
          for (const selector of [
            "[data-series-summary]",
            "[data-series-occurrence-summary]",
            "[data-series-empty]",
          ]) {
            const current = card.querySelector(selector)!;
            const next = updated.querySelector(selector)!;
            if (current.outerHTML !== next.outerHTML)
              current.replaceWith(document.importNode(next, true));
          }
          deferredEventRefresh =
            syncSeriesControls(card, updated, element) || deferredEventRefresh;
          syncList(
            card.querySelector("[data-series-event-list]")!,
            updated.querySelector("[data-series-event-list]")!,
          );
        }
        if (card !== position) list.insertBefore(card, position);
        position = card.nextElementSibling;
        continue;
      }
      // Don't discard an unrelated editor's draft or another action in flight.
      const protectedCard = card && protectedEvent(card);
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
        // Signup counts can change while an editor is open. Refresh only email
        // eligibility; leave the organizer's fields, reason and scope draft intact.
        for (const selector of [
          "[data-event-save]",
          "[data-event-cancel]",
          "[data-event-delete]",
        ]) {
          const form = card.querySelector(selector);
          const nextForm = updated.querySelector(selector);
          if (!form || !nextForm) continue;
          for (const attribute of [
            "data-email-prompt",
            "data-future-email-prompt",
          ]) {
            const value = nextForm.getAttribute(attribute);
            if (value === null) form.removeAttribute(attribute);
            else form.setAttribute(attribute, value);
          }
        }
      }
      if (
        !card ||
        (!protectedCard && renderedCards.get(card) !== updated.outerHTML)
      ) {
        const replacement = document.importNode(updated, true);
        renderedCards.set(replacement, updated.outerHTML);
        for (const selector of [".volunteer-roster", ".public-event-roster"]) {
          const details =
            replacement.querySelector<HTMLDetailsElement>(selector);
          if (details)
            details.open =
              card?.querySelector<HTMLDetailsElement>(selector)?.open ?? false;
        }
        if (card) {
          if (position === card) position = replacement;
          card.replaceWith(replacement);
        } else added ??= replacement;
        card = replacement;
      }
      if (card !== position) list.insertBefore(card, position);
      position = card.nextElementSibling;
    }
    for (const card of previous.values()) {
      if (
        protectedEvent(card) ||
        (card.querySelector("[data-live-series][open]") &&
          !card.contains(element ?? null))
      )
        deferredEventRefresh = true;
      else card.remove();
    }
  };
  syncList(list, refreshed.querySelector("[data-event-list]")!);
  for (const selector of ["[data-empty-events]", "[data-event-limit]"]) {
    const target = root.querySelector(selector);
    if (target) target.replaceWith(actionFragment(page, selector));
  }
  applyEventFilter(
    root,
    new URL(location.href).searchParams.get("type") ?? "all",
  );
  root.dataset.eventVersion = refreshed.dataset.eventVersion;
  initEventDates(root);
  if (element?.matches("[data-event-save]") && !eventId) element.reset();
  if (restoreFocus && (element || !focused?.isConnected)) {
    const card = eventId
      ? [...list.querySelectorAll<HTMLElement>("[data-live-event]")].find(
          (card) => card.dataset.liveEvent === eventId,
        )
      : seriesId
        ? [...list.querySelectorAll<HTMLElement>("[data-series-card]")].find(
            (card) => card.dataset.seriesCard === seriesId,
          )
        : added;
    const seriesForm = ["data-series-save", "data-series-occurrence"].find(
      (attribute) => element?.hasAttribute(attribute),
    );
    const selector =
      element?.matches("[data-live-signup]") ||
      (!element && focused?.closest("[data-live-signup]"))
        ? '[data-live-signup] button[type="submit"]'
        : seriesForm
          ? `[${seriesForm}] button[type="submit"]`
          : element?.matches("[data-event-save]")
            ? card?.dataset.seriesCard
              ? "[data-series-occurrences] > summary"
              : "[data-show-dialog]"
            : !element && focusedSeriesSummary
              ? focusedSeriesSummary
              : !element && focusedEventSummary
                ? focusedEventSummary
                : !element &&
                    focused instanceof HTMLElement &&
                    focused.dataset.showDialog
                  ? `[data-show-dialog="${CSS.escape(focused.dataset.showDialog)}"]`
                  : ".volunteer-roster summary";
    (card && !card.hidden
      ? !element && focused === focusedCard
        ? card
        : card.querySelector<HTMLElement>(selector)
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
}

async function refreshVolunteer(element: HTMLFormElement) {
  cancelVolunteerSearch();
  const userId = element.querySelector<HTMLInputElement>(
    'input[name="userId"]',
  )!.value;
  const profile = element.closest<HTMLElement>("[data-volunteer-profile]")!;
  const hostUrl = location.href;
  const profileUrl = `/manage/volunteers/${encodeURIComponent(userId)}`;
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
      : `[data-organizer-status][data-access-kind="${element.dataset.accessKind}"] button[type="submit"]`;
  if (profile.isConnected && (!dialog || dialog.open)) {
    profile.replaceWith(replacement);
    if (dialog && scroll !== undefined) dialog.scrollTop = scroll;
    if (restoreFocus)
      replacement
        .querySelector<HTMLElement>(selector)
        ?.focus({ preventScroll: true });
  }
  if (host && location.href === hostUrl) {
    syncVolunteerBrowser(host);
    syncEvents(host);
  }
}

let pendingRefresh = Promise.resolve();

document.addEventListener("application-progress-updated", (event) => {
  if (event instanceof CustomEvent && event.detail instanceof Document)
    syncEvents(event.detail);
});

const eventBrowser = document.querySelector<HTMLElement>(
  "[data-event-browser]",
);
if (eventBrowser) {
  const inactivityTimeout = 5 * 60_000;
  let lastActivity = Date.now();
  let inactivityTimer: number | undefined;
  let timer: number | undefined;
  let pollInterval: number | undefined;
  let polling = false;
  let pendingPoll: AbortController | undefined;
  let liveRefreshQueued = false;
  let forceRefresh = false;
  const refreshLiveEvents = (force = false) => {
    forceRefresh ||= force;
    if (
      liveRefreshQueued ||
      !polling ||
      document.hidden ||
      Date.now() - lastActivity >= inactivityTimeout
    )
      return;
    liveRefreshQueued = true;
    const controller = new AbortController();
    pendingPoll = controller;
    // Share the action refresh queue so an older poll cannot undo a newer
    // signup. Skip timer ticks while a check or page refresh is in flight.
    const refresh = pendingRefresh.then(async () => {
      if (controller.signal.aborted) return;
      if (!forceRefresh) {
        const versionUrl = new URL("/api/v1/events/version", location.origin);
        if (eventBrowser.dataset.eventView === "manage")
          versionUrl.searchParams.set("view", "manage");
        const selectedOccurrence = new URL(location.href).searchParams.get(
          "occurrence",
        );
        if (selectedOccurrence)
          versionUrl.searchParams.set("occurrence", selectedOccurrence);
        const response = await fetch(versionUrl, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected)
          throw new Error("Event updates are unavailable.");
        const result: { version?: unknown } = await response.json();
        const needsDeferredRefresh =
          deferredEventRefresh &&
          !eventBrowser.querySelector(
            'dialog[open], [data-live-series][open], form[data-submitting="true"]',
          );
        if (
          !forceRefresh &&
          (typeof result.version !== "string" ||
            !/^[a-f0-9]{64}$/.test(result.version) ||
            (result.version === eventBrowser.dataset.eventVersion &&
              !needsDeferredRefresh))
        )
          return;
      }
      forceRefresh = false;
      const page = await loadActionPage(location.href, controller.signal);
      if (!controller.signal.aborted) syncEvents(page);
    });
    // A failed check or refresh is retried on the next polling tick.
    pendingRefresh = refresh.catch(() => {});
    void pendingRefresh.finally(() => {
      pendingPoll = undefined;
      liveRefreshQueued = false;
      if (polling && (forceRefresh || controller.signal.aborted))
        refreshLiveEvents();
    });
  };
  refreshDeferredEvents = () => refreshLiveEvents(true);
  const syncPollingInterval = () => {
    const interval =
      eventBrowser.dataset.applicationAwaitingApproval === "true"
        ? 60_000
        : 5_000;
    if (timer !== undefined && pollInterval === interval) return;
    window.clearInterval(timer);
    pollInterval = interval;
    timer = window.setInterval(() => refreshLiveEvents(), interval);
  };
  const stopPolling = () => {
    polling = false;
    window.clearInterval(timer);
    timer = undefined;
    window.clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
    pendingPoll?.abort();
  };
  const checkInactivity = () => {
    const remaining = inactivityTimeout - (Date.now() - lastActivity);
    if (remaining <= 0) stopPolling();
    else inactivityTimer = window.setTimeout(checkInactivity, remaining);
  };
  const startPolling = () => {
    if (polling || document.hidden) return;
    lastActivity = Date.now();
    polling = true;
    inactivityTimer = window.setTimeout(checkInactivity, inactivityTimeout);
    syncPollingInterval();
    refreshLiveEvents();
  };
  const recordActivity = () => {
    if (document.hidden) return;
    // Move the deadline without resetting timers on every pointer move or key.
    lastActivity = Date.now();
    startPolling();
  };
  for (const type of [
    "pointerdown",
    "pointermove",
    "keydown",
    "input",
    "click",
    "wheel",
  ])
    document.addEventListener(type, recordActivity, {
      passive: true,
      capture: true,
    });
  window.addEventListener("focus", recordActivity);
  document.addEventListener("account-content-updated", () => {
    if (polling) syncPollingInterval();
  });
  document.addEventListener("visibilitychange", () =>
    document.hidden ? stopPolling() : startPolling(),
  );
  window.addEventListener("pagehide", stopPolling);
  window.addEventListener("pageshow", startPolling);
  document.addEventListener(
    "toggle",
    (event) => {
      if (
        deferredEventRefresh &&
        event.target instanceof HTMLDetailsElement &&
        event.target.matches("[data-live-series]") &&
        !event.target.open
      )
        refreshDeferredEvents();
    },
    true,
  );
  document.addEventListener(
    "close",
    (event) => {
      if (
        deferredEventRefresh &&
        event.target instanceof HTMLDialogElement &&
        event.target.closest("[data-live-event]")
      )
        refreshDeferredEvents();
    },
    true,
  );
  startPolling();
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
    if (element.matches("[data-event-save], [data-series-save]")) {
      initEventDates(element);
      readDateInputs(element);
      if (!element.reportValidity()) return;
    }
    const button = submitButton(element);
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
    const loadingLabel = loading?.textContent;
    const resultTitle = element.matches("[data-event-delete]")
      ? "Deleted"
      : element.matches("[data-series-save]")
        ? "Patrol series saved"
        : element.matches("[data-event-save]")
          ? "Event saved"
          : element.matches("[data-event-cancel]")
            ? "Event cancelled"
            : element.matches("[data-manage-signup]")
              ? "Registration changed"
              : element.matches("[data-organizer-role]")
                ? "Account role saved"
                : "Volunteer access saved";
    const message = element.querySelector<HTMLElement>("[data-form-message]");
    if (message) {
      message.hidden = true;
      message.textContent = "";
    }
    let saved = false;
    try {
      if (
        element.matches("[data-event-delete]") &&
        !(await confirmEventDeletion(element.dataset.eventDelete ?? "event"))
      )
        return;
      let notify: boolean | undefined;
      const prompt = eventEmailPrompt(
        values,
        element.dataset.emailPrompt,
        element.dataset.futureEmailPrompt,
      );
      if (prompt) {
        const choice = await chooseNotification(prompt);
        if (choice === null) {
          if (element.hasAttribute("data-submit-on-change")) element.reset();
          return;
        }
        notify = choice;
      }
      element.setAttribute("aria-busy", "true");
      if (loading) {
        loading.hidden = false;
        if (notify) loading.textContent = "Sending…";
      }
      if (button && (notify || button.dataset.loadingLabel)) {
        button.textContent = notify ? "Sending…" : button.dataset.loadingLabel!;
        button.setAttribute("aria-busy", "true");
      }
      if (notify && message) {
        message.hidden = false;
        message.setAttribute("role", "status");
        message.textContent = "Sending…";
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
      const result: EmailActionResult = await response.json();
      if (!response.ok)
        throw new Error(result.message || "The change could not be saved.");
      saved = true;
      const simulationSucceeded = await simulateActionEmail(result);
      const emailNeedsFeedback = actionEmailNeedsFeedback(
        result,
        simulationSucceeded,
      );
      if (notify && message) {
        message.hidden = !emailNeedsFeedback;
        message.textContent = emailNeedsFeedback
          ? (result.message ?? "Email delivery could not be confirmed.")
          : "";
        message.setAttribute("role", emailNeedsFeedback ? "alert" : "status");
      }
      // Writes may run concurrently, but each refresh must fetch and apply after
      // the previous one. Otherwise a slower, older response can undo newer UI.
      const refresh = pendingRefresh.then(() => complete(element));
      pendingRefresh = refresh.catch(() => {});
      let refreshFailed = false;
      try {
        await refresh;
      } catch {
        refreshFailed = true;
        result.message = `${result.message ?? "Change saved."} The view could not be refreshed; reload to see the saved change.`;
      }
      if (emailNeedsFeedback || refreshFailed)
        showActionEmailFeedback(resultTitle, endpoint, result);
    } catch (error) {
      // Failed automatic toggles must not look like committed settings.
      if (!saved && element.hasAttribute("data-submit-on-change"))
        element.reset();
      if (message) {
        message.setAttribute("role", "alert");
        message.dataset.messageKind = "error";
        message.textContent = saved
          ? "The change is saved, but its feedback could not be displayed. Reload to see the saved change."
          : error instanceof TypeError
            ? "The action could not be confirmed. Reload before making further changes."
            : error instanceof Error
              ? error.message
              : "The action could not be confirmed. Reload before making further changes.";
        message.hidden = false;
        if (element.closest(".dialog-frame"))
          message.scrollIntoView({ block: "nearest" });
      }
    } finally {
      for (const control of controls) control.disabled = false;
      if (button) {
        button.removeAttribute("aria-busy");
        if (button.dataset.loadingLabel || button.textContent === "Sending…")
          button.textContent = label ?? "";
      }
      element.removeAttribute("aria-busy");
      if (loading) {
        loading.hidden = true;
        loading.textContent = loadingLabel ?? "";
      }
      delete element.dataset.submitting;
      delete scope.dataset.submitting;
      initRecurrenceControls(
        element.closest<HTMLElement>("[data-event-browser]") ?? element,
      );
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
form(
  "[data-event-save]",
  "/api/v1/events/action",
  (v) =>
    recurringSaveAction(v) ?? {
      action: "save",
      ...(v.has("id")
        ? { id: str(v, "id"), version: Number(v.get("version")) }
        : {}),
      event: {
        includesOrientation: v.has("includesOrientation"),
        startsAt: vancouverInstant(str(v, "startsAt")),
        meetingPoint: str(v, "meetingPoint"),
        meetingPointUrl: str(v, "meetingPointUrl"),
        spots: Number(v.get("spots")),
        // Keep the existing API/storage flags in sync from the single control.
        open: str(v, "publicVisibility") === "true",
        hidden: str(v, "publicVisibility") !== "true",
      },
    },
);
form(
  "[data-event-cancel]",
  "/api/v1/events/action",
  (v) =>
    recurringCancelAction(v) ?? {
      action: "cancel-event",
      id: str(v, "id"),
      version: Number(v.get("version")),
      reason: str(v, "reason"),
    },
);
form("[data-series-save]", "/api/v1/events/action", seriesSaveAction);
form("[data-event-delete]", "/api/v1/events/action", (v) => ({
  action: str(v, "action"),
  id: str(v, "id"),
  version: Number(v.get("version")),
}));
form(
  "[data-series-occurrence]",
  "/api/v1/events/action",
  (v) => ({
    action: "materialize-occurrence",
    id: str(v, "seriesId"),
    occurrenceDate: str(v, "occurrenceDate"),
  }),
  async (element) => {
    const value = (name: string) =>
      element.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value;
    const id = `patrol:${value("seriesId")}:${value("occurrenceDate")}`;
    const url = new URL(location.href);
    url.searchParams.set("occurrence", id);
    const page = await loadActionPage(url.href);
    history.replaceState(null, "", url);
    syncEvents(page, element);
    const card = [
      ...document.querySelectorAll<HTMLElement>("[data-live-event]"),
    ].find((item) => item.dataset.liveEvent === id);
    const occurrences = card?.closest<HTMLDetailsElement>(
      "[data-series-occurrences]",
    );
    if (occurrences) occurrences.open = true;
    card?.scrollIntoView({ block: "nearest" });
    card?.querySelector<HTMLButtonElement>("[data-show-dialog]")?.click();
  },
);
form("[data-manage-signup]", "/api/v1/events/action", (v) => ({
  action: "manage-signup",
  id: str(v, "id"),
  ...(v.get("destination") ? { destination: str(v, "destination") } : {}),
  reason: str(v, "reason"),
}));
form(
  "[data-organizer-status]",
  "/api/v1/organizer/action",
  (v) => ({
    action: "status",
    userId: str(v, "userId"),
    version: Number(v.get("version")),
    active: v.has("active"),
    applicationApproved: v.has("applicationApproved"),
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
  const step = event.target.closest<HTMLButtonElement>("[data-spots-step]");
  if (!step || step.disabled || step.closest("[data-submitting]")) return;
  const input = step.form?.querySelector<HTMLInputElement>(
    'input[name="spots"]',
  );
  if (!input || input.disabled || input.readOnly) return;
  const before = input.value;
  const value = input.valueAsNumber;
  // Recover empty/out-of-range drafts at the nearest limit; otherwise retain
  // native integer-step rounding and keyboard editing on the number input.
  if (!Number.isFinite(value) || value < Number(input.min))
    input.value = input.min;
  else if (value > Number(input.max)) input.value = input.max;
  else input.stepUp(Number(step.dataset.spotsStep));
  if (input.value !== before) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
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
    if (dialog instanceof HTMLDialogElement) {
      initEventDates(dialog);
      dialog.showModal();
    }
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
  profileDialog.addEventListener("close", async () => {
    if (profileDialog.open) return;
    const closingRequest = pending;
    closingRequest?.abort();
    // The native close event precedes the visible exit. Wait only for the
    // dialog's own transitions, not animations inside the fetched profile.
    await Promise.allSettled(
      profileDialog.getAnimations().map((animation) => animation.finished),
    );
    // A rapid reopen (even followed by another close) owns its own cleanup.
    if (profileDialog.open || pending !== closingRequest) return;
    pending = undefined;
    profileContent.replaceChildren();
    profileContent.removeAttribute("aria-busy");
    profileContent.scrollTop = 0;
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
    profileContent.scrollTop = 0;
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

initVolunteerBrowser();

document.addEventListener("click", (event) => {
  const dialog = event.target;
  if (
    !(dialog instanceof HTMLDialogElement) ||
    !dialog.matches(".volunteer-dialog")
  )
    return;
  if (
    dialog.hasAttribute("data-action-email-feedback") &&
    dialog.getAttribute("aria-busy") === "true"
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
