import { updateLocalUrl } from "./local-history";
import { vancouverInstant } from "../data/event-time";
import { savedFormValues, trackUnsavedChanges } from "./unsaved-changes";
import { chooseSeriesScope, type SaveScope } from "./series-scope-prompt";
import {
  handleEventCalendarClick,
  initEventCalendarSwipe,
  syncEventCalendar,
} from "./event-calendar";
import { actionFragment, loadActionPage } from "./action-page";
import { syncApplicationProgress } from "./application-progress";
import { focusAfterUpdate } from "./focus";
import {
  confirmEventRestore,
  confirmEventUnregistration,
} from "./confirm-dialog";
import { initDateInputs, readDateInputs } from "./date-input";
import {
  disposeVolunteerProfileContents,
  initVolunteerProfileContents,
} from "./volunteer-profile-contents";
import { initSignupMenus } from "./signup-menu";
import {
  initSignupMoveCalendars,
  syncSignupMoveCalendar,
} from "./signup-move-calendar";
import {
  initBulkEvents,
  syncBulkEventSelection,
  setBulkEventSelecting,
  bulkEventAction,
} from "./event-bulk";
import {
  initRecurrenceControls,
  recurringSaveAction,
  seriesScheduleChanged,
  recurringCancelAction,
  eventEmailPrompt,
  eventFields,
} from "./event-recurrence";
import {
  actionEmailNeedsFeedback,
  showActionEmailFeedback,
  type EmailActionResult,
} from "./action-email-feedback";
import { onPageLoad } from "./page-lifecycle";
onPageLoad((page) => {
  if (
    !document.querySelector(
      "[data-event-browser], [data-volunteer-profile], [data-application-review]",
    )
  )
    return;

  const isCurrent = () => !page.signal.aborted;

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
      "[data-event-save]:not([data-submitting])",
    )) {
      if (form.matches("[data-track-changes]")) trackUnsavedChanges(form);
      else {
        const button = submitButton(form);
        if (button) button.disabled = false;
      }
      for (const step of form.querySelectorAll<HTMLButtonElement>(
        "[data-stepper-step]",
      ))
        step.disabled = false;
    }
  }

  function initVolunteerControls(root: Document | HTMLElement) {
    for (const group of root.querySelectorAll<HTMLElement>(
      "[data-volunteer-controls]:not([data-submitting])",
    ))
      for (const control of group.querySelectorAll<
        HTMLElement & { disabled: boolean }
      >("[data-volunteer-control]"))
        control.disabled = false;
  }

  // Compare against the server HTML, not transient loading/expanded state.
  const renderedCards = new WeakMap<HTMLElement, string>();

  let deferredEventRefresh = false;

  let refreshDeferredEvents = () => {};

  for (const card of document.querySelectorAll<HTMLElement>(
    "[data-live-event]",
  ))
    renderedCards.set(card, card.outerHTML);

  initEventDates(document);

  initVolunteerProfileContents();
  page.cleanup(() => disposeVolunteerProfileContents(document.body));

  initSignupMenus(page);

  initSignupMoveCalendars(page);

  function syncEventBrowser(root: HTMLElement) {
    const empty = root.querySelector<HTMLElement>("[data-empty-events]");
    if (empty)
      empty.hidden = Boolean(
        root.querySelector("[data-event-list] > [data-live-event]"),
      );
    syncEventCalendar(root);
    syncBulkEventSelection(root);
  }

  document
    .querySelectorAll<HTMLElement>("[data-event-browser]")
    .forEach((root) => {
      syncEventCalendar(root);
      initBulkEvents(root);
      initEventCalendarSwipe(root);
      root.addEventListener("click", (event) =>
        handleEventCalendarClick(root, event),
      );
      page.onWindow("popstate", () => syncEventCalendar(root));
      page.onWindow("app:local-history", () => syncEventCalendar(root));
    });

  function syncEvents(page: Document, element?: HTMLFormElement) {
    if (!isCurrent()) return;
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
        if (url.href !== location.href) updateLocalUrl(url, "replace");
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
      for (const card of root.querySelectorAll<HTMLElement>(
        "[data-live-event]",
      ))
        renderedCards.set(card, card.outerHTML);
      syncEventBrowser(root);
      initEventDates(root);
      if (restoreFocus)
        focusAfterUpdate(
          root.querySelector(
            '[aria-current="step"] summary, #events-heading',
          ) ?? document.querySelector("[data-portal-heading]"),
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
        : focusedCard,
    );
    dialog?.close();
    let added: HTMLElement | undefined;
    const protectedEvent = (card: HTMLElement) =>
      Boolean(
        card.querySelector("dialog[open], [data-signup-menu]:popover-open") ||
        [
          ...card.querySelectorAll<HTMLFormElement>(
            'form[data-submitting="true"], add-attendee[data-expanded] form',
          ),
        ].some((form) => form !== element),
      );
    const key = (card: HTMLElement) => `event:${card.dataset.liveEvent}`;
    // A date can move between upcoming events and history as it starts.
    // Reuse its roster expansion state, and never duplicate an open editor.
    const existingEvents = new Map(
      [...root.querySelectorAll<HTMLElement>("[data-live-event]")].map(
        (card) => [key(card), card],
      ),
    );
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
        let card = previous.get(id) ?? existingEvents.get(id);
        previous.delete(id);
        if (card && card.parentElement !== list && protectedEvent(card)) {
          deferredEventRefresh = true;
          continue;
        }
        // Don't discard an unrelated editor's draft or another action in flight.
        const protectedCard = card && protectedEvent(card);
        if (card && protectedCard) {
          if (renderedCards.get(card) !== updated.outerHTML)
            deferredEventRefresh = true;
          // A live count must not overwrite an open editor or an in-flight signup.
          // Compare the live region itself: after a partial update, a return to
          // the cached full-card snapshot must still restore its original count.
          const availability = card.querySelector("[data-event-availability]");
          const nextAvailability = updated.querySelector(
            "[data-event-availability]",
          );
          if (
            availability &&
            nextAvailability &&
            availability.outerHTML !== nextAvailability.outerHTML
          )
            availability.replaceWith(
              document.importNode(nextAvailability, true),
            );
          // Signup counts can change while an editor is open. Refresh only email
          // eligibility; leave the organizer's fields, reason and scope draft intact.
          for (const selector of ["[data-event-save]", "[data-event-cancel]"]) {
            const form = card.querySelector(selector);
            const nextForm = updated.querySelector(selector);
            if (!form || !nextForm) continue;
            for (const attribute of [
              "data-email-prompt",
              "data-future-email-prompt",
              "data-all-email-prompt",
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
          for (const selector of [
            ".volunteer-roster",
            ".public-event-roster",
          ]) {
            const details =
              replacement.querySelector<HTMLDetailsElement>(selector);
            if (details)
              details.open =
                card?.querySelector<HTMLDetailsElement>(selector)?.open ??
                false;
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
        if (protectedEvent(card)) deferredEventRefresh = true;
        else card.remove();
      }
    };
    syncList(list, refreshed.querySelector("[data-event-list]")!);
    let pastList = root.querySelector<HTMLElement>("[data-past-event-list]");
    const nextPastList = refreshed.querySelector<HTMLElement>(
      "[data-past-event-list]",
    );
    // History is omitted when empty, but can appear or disappear during polling.
    if (!pastList && nextPastList) {
      const section = document.importNode(
        nextPastList.closest("section")!,
        true,
      );
      pastList = section.querySelector<HTMLElement>("[data-past-event-list]")!;
      // Reconcile cards normally so an occurrence keeps its expanded roster.
      pastList.replaceChildren();
      root.insertBefore(section, list.closest("section")!.nextSibling);
    } else if (pastList && !nextPastList) {
      pastList.closest("section")!.remove();
    }
    if (pastList && nextPastList) syncList(pastList, nextPastList);
    for (const selector of [
      "[data-empty-events]",
      "[data-event-limit]",
      "[data-past-event-limit]",
    ]) {
      const target = root.querySelector(selector);
      if (target) target.replaceWith(actionFragment(page, selector));
    }
    syncEventBrowser(root);
    root.dataset.eventVersion = refreshed.dataset.eventVersion;
    initEventDates(root);
    if (element?.matches("[data-event-save]") && !eventId) element.reset();
    if (restoreFocus && (element || !focused?.isConnected)) {
      const card = eventId
        ? [...root.querySelectorAll<HTMLElement>("[data-live-event]")].find(
            (card) => card.dataset.liveEvent === eventId,
          )
        : added;
      const selector =
        !element && focused?.matches("[data-bulk-event]")
          ? "[data-bulk-event]"
          : element?.matches("[data-live-signup]") ||
              (!element && focused?.closest("[data-live-signup]"))
            ? '[data-live-signup] button[type="submit"]'
            : element?.matches(
                  "[data-event-save], [data-event-cancel], [data-event-restore]",
                )
              ? "[data-show-dialog]"
              : element?.matches("[data-add-attendee]") ||
                  (!element && focused?.matches("[data-attendee-open]"))
                ? "[data-attendee-open]"
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
          : (card.querySelector<HTMLElement>(selector) ?? card)
        : null
      )?.focus({ preventScroll: true });
      if (document.activeElement === document.body)
        focusAfterUpdate(root.querySelector("#events-heading"));
    }
  }

  async function refreshEvents(element: HTMLFormElement) {
    const page = await loadActionPage();
    syncEvents(page, element);
  }

  async function refreshVolunteer(element: HTMLFormElement) {
    const profile = element.closest<HTMLElement>(
      "[data-volunteer-profile], [data-application-review]",
    )!;
    const rootSelector = profile.matches("[data-application-review]")
      ? "[data-application-review]"
      : "[data-volunteer-profile]";
    const page = await loadActionPage();
    if (!isCurrent()) return;
    const replacement = actionFragment(page, rootSelector);
    initVolunteerControls(replacement);
    const applicationOpen = profile.querySelector<HTMLDetailsElement>(
      "[data-submitted-application] details",
    )?.open;
    const nextApplication = replacement.querySelector<HTMLDetailsElement>(
      "[data-submitted-application] details",
    );
    if (nextApplication && applicationOpen) nextApplication.open = true;
    // Replace all status forms together to keep versions and hidden values in sync.
    const active = document.activeElement;
    const restoreFocus = element.contains(active) || active === document.body;
    const selector = element.matches("[data-organizer-role]")
      ? '[data-organizer-role] select[name="role"]'
      : element.matches(
            '[data-organizer-rejection], [data-organizer-status][data-access-kind="application"]',
          )
        ? "[data-decision-open]"
        : element.hasAttribute("data-submit-on-change")
          ? '[data-organizer-status][data-submit-on-change] input[name="active"]'
          : element.dataset.accessKind === "patrol"
            ? "[data-patrol-approval] [data-decision-open]"
            : `[data-organizer-status][data-access-kind="${element.dataset.accessKind}"] button[type="submit"]`;
    if (profile.isConnected) {
      disposeVolunteerProfileContents(profile);
      profile.replaceWith(replacement);
      initVolunteerProfileContents(replacement, true);
      if (restoreFocus)
        (
          replacement.querySelector<HTMLElement>(selector) ??
          replacement.querySelector<HTMLElement>(
            "[data-application-review-heading]",
          )
        )?.focus({ preventScroll: true });
    }
  }

  let pendingRefresh = Promise.resolve();

  page.onDocument("application-progress-updated", (event) => {
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
          if (eventBrowser.dataset.eventViewAs)
            versionUrl.searchParams.set(
              "viewAs",
              eventBrowser.dataset.eventViewAs,
            );
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
              'dialog[open], add-attendee[data-expanded], [data-signup-menu]:popover-open, form[data-submitting="true"]',
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
      page.onDocument(type, recordActivity, {
        passive: true,
        capture: true,
      });
    page.onWindow("focus", recordActivity);
    page.onDocument("account-content-updated", () => {
      if (polling) syncPollingInterval();
    });
    page.onDocument("visibilitychange", () =>
      document.hidden ? stopPolling() : startPolling(),
    );
    page.onWindow("pagehide", stopPolling);
    page.onWindow("pageshow", startPolling);
    page.onDocument(
      "toggle",
      (event) => {
        if (
          deferredEventRefresh &&
          event.target instanceof HTMLElement &&
          event.target.matches("[data-signup-menu]:not(:popover-open)")
        )
          refreshDeferredEvents();
      },
      true,
    );
    page.onDocument(
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
    page.onDocument("add-attendee-close", () => {
      if (deferredEventRefresh) refreshDeferredEvents();
    });
    page.cleanup(stopPolling);
    startPolling();
  }

  function form(
    selector: string,
    endpoint: string,
    body: (values: FormData, element: HTMLFormElement) => object,
    complete: (element: HTMLFormElement) => Promise<void> = refreshEvents,
  ) {
    page.onDocument("submit", async (event) => {
      const element = event.target;
      if (!(element instanceof HTMLFormElement) || !element.matches(selector))
        return;
      event.preventDefault();
      const scope =
        element.closest<HTMLElement>(
          "[data-volunteer-profile], [data-application-review]",
        ) ??
        element.closest<HTMLElement>("[data-volunteer-controls], dialog") ??
        element;
      if (scope.dataset.submitting) return;
      if (element.matches("[data-bulk-event-save]")) {
        syncBulkEventSelection(
          element.closest<HTMLElement>("[data-event-browser]")!,
        );
        if (!element.reportValidity()) return;
      }
      if (element.matches("[data-event-save]")) {
        initEventDates(element);
        readDateInputs(element);
        if (!element.reportValidity()) return;
      }
      const button = submitButton(element);
      if (button?.disabled) return;
      let seriesScope: SaveScope | null = null;
      if (
        element.matches("[data-event-save]") &&
        element.elements.namedItem("seriesId")
      ) {
        seriesScope = await chooseSeriesScope(
          element,
          seriesScheduleChanged(
            new FormData(element),
            savedFormValues(element),
          ),
        );
        if (!seriesScope || scope.dataset.submitting) return;
      }
      const focused = document.activeElement;
      element.dataset.submitting = "true";
      scope.dataset.submitting = "true";
      const values = new FormData(element);
      if (seriesScope) values.set("scope", seriesScope);
      const controls = [
        ...scope.querySelectorAll<HTMLElement & { disabled: boolean }>(
          'input:not([type="hidden"]), select, textarea, button',
        ),
      ].filter((control) => !control.disabled);
      for (const control of controls) control.disabled = true;
      const loading = element.querySelector<HTMLElement>(
        "[data-action-loading]",
      );
      // Keep any icon beside the label once the loading text is replaced.
      const label = button?.innerHTML;
      const loadingLabel = loading?.textContent;
      const resultTitle = element.matches("[data-bulk-event-save]")
        ? "Selected events saved"
        : element.matches("[data-event-restore]")
          ? "Event restored"
          : element.matches("[data-event-save]")
            ? "Event saved"
            : element.matches("[data-event-cancel]")
              ? "Event cancelled"
              : element.matches("[data-manage-signup]")
                ? "Registration changed"
                : element.matches("[data-add-attendee]")
                  ? "Volunteers added"
                  : element.matches("[data-organizer-role]")
                    ? "Account role saved"
                    : element.matches("[data-organizer-rejection]")
                      ? "Application rejected"
                      : "Volunteer access saved";
      const message = element.querySelector<HTMLElement>("[data-form-message]");
      if (message) {
        message.hidden = true;
        message.textContent = "";
      }
      let saved = false;
      try {
        if (
          element.matches("[data-live-signup]") &&
          values.get("action") === "cancel" &&
          !(await confirmEventUnregistration(element))
        )
          return;
        if (
          element.matches("[data-event-restore]") &&
          !(await confirmEventRestore(element))
        )
          return;
        const notify =
          element.matches("[data-organizer-rejection], [data-notify]") ||
          Boolean(
            eventEmailPrompt(
              values,
              element.dataset.emailPrompt,
              element.dataset.futureEmailPrompt,
              element.dataset.allEmailPrompt,
            ),
          ) ||
          undefined;
        element.setAttribute("aria-busy", "true");
        if (loading) {
          loading.hidden = false;
          if (notify) loading.textContent = "Sending…";
        }
        if (button && (notify || button.dataset.loadingLabel)) {
          button.textContent = notify
            ? "Sending…"
            : button.dataset.loadingLabel!;
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
            ...body(values, element),
            ...(notify === undefined ||
            element.matches("[data-organizer-rejection]")
              ? {}
              : { notify }),
          }),
        });
        const result: EmailActionResult & { pendingActionId?: string } =
          await response.json();
        // Blocked by a waiting change: offer that change's buttons.
        if (result.pendingActionId)
          document.dispatchEvent(
            new CustomEvent("pending-action-blocked", {
              detail: { id: result.pendingActionId },
            }),
          );
        if (!response.ok)
          throw new Error(result.message || "The change could not be saved.");
        saved = true;
        // Changes that email wait for their undo timer; the email comes later.
        document.dispatchEvent(new Event("app-data-changed"));
        if (result.pendingAction) {
          pendingForms.set(result.pendingAction.id, formSelector(element));
          // Undo reopens a dialog form with what was entered, like a draft.
          // Its "id" field hides element.id.
          const formId = element.getAttribute("id");
          if (
            formId &&
            element.closest("dialog") &&
            !element.matches("[data-bulk-event-save]")
          )
            pendingDrafts.set(result.pendingAction.id, {
              formId,
              values: [...values].filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            });
          document.dispatchEvent(
            new CustomEvent("pending-action-added", {
              detail: result.pendingAction,
            }),
          );
        }
        if (!isCurrent()) return;
        const emailNeedsFeedback = actionEmailNeedsFeedback(result);
        if (notify && message) {
          message.hidden = !emailNeedsFeedback;
          message.textContent = emailNeedsFeedback
            ? (result.message ?? "Email delivery could not be confirmed.")
            : "";
          message.setAttribute("role", emailNeedsFeedback ? "alert" : "status");
        }
        // Writes may run concurrently, but each refresh must fetch and apply after
        // the previous one. Otherwise a slower, older response can undo newer UI.
        const refresh = pendingRefresh.then(() =>
          isCurrent() ? complete(element) : undefined,
        );
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
            button.innerHTML = label ?? "";
        }
        element.removeAttribute("aria-busy");
        if (loading) {
          loading.hidden = true;
          loading.textContent = loadingLabel ?? "";
        }
        delete element.dataset.submitting;
        delete scope.dataset.submitting;
        // A saved form's current values are its new baseline.
        if (element.matches("[data-track-changes]"))
          trackUnsavedChanges(element, saved);
        const browser = element.closest<HTMLElement>("[data-event-browser]");
        if (browser) syncBulkEventSelection(browser);
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

  form(
    "[data-bulk-event-save]",
    "/api/v1/events/action",
    bulkEventAction,
    async (element) => {
      const root = element.closest<HTMLElement>("[data-event-browser]")!;
      element.closest<HTMLDialogElement>("dialog")!.close();
      setBulkEventSelecting(root, false);
      await refreshEvents(element);
      root.querySelector<HTMLButtonElement>("[data-bulk-select-mode]")?.focus();
    },
  );

  form("[data-live-signup]", "/api/v1/events/action", (v) => ({
    action: str(v, "action"),
    id: str(v, "id"),
  }));

  form("[data-add-attendee]", "/api/v1/events/action", (values) => ({
    action: "add-volunteers",
    id: str(values, "id"),
    volunteers: values
      .getAll("volunteers")
      .map((value) => JSON.parse(String(value))),
  }));

  form(
    "[data-event-save]",
    "/api/v1/events/action",
    (v, element) =>
      recurringSaveAction(v, savedFormValues(element)) ?? {
        action: "save",
        ...(v.has("id")
          ? { id: str(v, "id"), version: Number(v.get("version")) }
          : {}),
        event: {
          ...eventFields(v),
          startsAt: vancouverInstant(str(v, "startsAt")),
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

  form("[data-event-restore]", "/api/v1/events/action", (v) => ({
    action: "restore-occurrence",
    id: str(v, "id"),
    version: Number(v.get("version")),
  }));

  form("[data-manage-signup]", "/api/v1/events/action", (v) => ({
    action: "manage-signup",
    id: str(v, "id"),
    ...(v.get("destination") ? { destination: str(v, "destination") } : {}),
    reason: str(v, "reason"),
  }));

  form(
    "[data-organizer-status]",
    "/api/v1/organizer/action",
    (v) =>
      v.has("approvePatrols")
        ? {
            action: "approve-patrols",
            userId: str(v, "userId"),
            version: Number(v.get("version")),
          }
        : {
            action: "status",
            userId: str(v, "userId"),
            version: Number(v.get("version")),
            active: v.has("active"),
            applicationApproved: v.has("applicationApproved"),
            patrolApproved: v.has("patrolApproved"),
            ...(v.has("reason") ? { reason: str(v, "reason") } : {}),
          },
    refreshVolunteer,
  );

  form(
    "[data-organizer-rejection]",
    "/api/v1/organizer/action",
    (v) => ({
      action: "reject-application",
      userId: str(v, "userId"),
      version: Number(v.get("version")),
      reason: str(v, "reason"),
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

  form("[data-organizer-patrol-approval]", "/api/v1/organizer/action", (v) => ({
    action: "approve-patrols",
    userId: str(v, "userId"),
    eventId: str(v, "eventId"),
    version: Number(v.get("version")),
  }));

  page.onDocument("change", (event) => {
    if (!(event.target instanceof Element)) return;
    event.target
      .closest<HTMLFormElement>("form[data-submit-on-change]")
      ?.requestSubmit();
  });

  page.onDocument("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const step = event.target.closest<HTMLButtonElement>("[data-stepper-step]");
    if (!step || step.disabled || step.closest("[data-submitting]")) return;
    const input = document.getElementById(
      step.getAttribute("aria-controls") ?? "",
    );
    if (
      !(input instanceof HTMLInputElement) ||
      input.disabled ||
      input.readOnly
    )
      return;
    const before = input.value;
    const value = input.valueAsNumber;
    // Recover empty/out-of-range drafts at the nearest limit; otherwise retain
    // native integer-step rounding and keyboard editing on the number input.
    if (!Number.isFinite(value) || value < Number(input.min))
      input.value = input.min;
    else if (value > Number(input.max)) input.value = input.max;
    else input.stepUp(Number(step.dataset.stepperStep));
    if (input.value !== before) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  page.onDocument("click", (event) => {
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
        syncSignupMoveCalendar(dialog);
        dialog.showModal();
      }
    }
  });

  page.onDocument("click", (event) => {
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
    if (dialog.id === "bulk-event-editor" && dialog.dataset.submitting) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });

  // Forms that started waiting changes, found again after refreshes replace them.
  const pendingForms = new Map<string, string>();

  const pendingDrafts = new Map<
    string,
    { formId: string; values: [string, string][] }
  >();

  /** Put an undone change back in its dialog, as the organizer entered it. */
  function restoreDraft(draft: { formId: string; values: [string, string][] }) {
    const form = document.getElementById(draft.formId);
    const dialog = form?.closest("dialog");
    if (!(form instanceof HTMLFormElement) || !dialog || dialog.open) return;
    initEventDates(dialog);
    syncSignupMoveCalendar(dialog);
    for (const control of form.elements) {
      if (
        !(
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
        ) ||
        !control.name ||
        ["hidden", "file", "submit", "button"].includes(control.type)
      )
        continue;
      const saved = draft.values
        .filter(([name]) => name === control.name)
        .map(([, value]) => value);
      if (
        control instanceof HTMLInputElement &&
        (control.type === "checkbox" || control.type === "radio")
      ) {
        const checked = saved.includes(control.value);
        if (control.checked === checked) continue;
        control.checked = checked;
      } else if (!saved.length || control.value === saved[0]) continue;
      else control.value = saved[0];
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
    dialog.showModal();
  }

  function formSelector(element: HTMLFormElement) {
    const kind = element.dataset.accessKind;
    return [
      "form",
      ...[
        "data-organizer-status",
        "data-organizer-role",
        "data-organizer-rejection",
        "data-submit-on-change",
      ]
        .filter((name) => element.hasAttribute(name))
        .map((name) => `[${name}]`),
      kind ? `[data-access-kind="${CSS.escape(kind)}"]` : "",
    ].join("");
  }

  // A waiting change was made or undone: show the item as it is now.
  page.onDocument("pending-action-resolved", (event) => {
    const { action, outcome, refreshes } = (
      event as CustomEvent<{
        action: { id: string };
        outcome: "done" | "undone";
        refreshes: Promise<unknown>[];
      }>
    ).detail;
    const draft = pendingDrafts.get(action.id);
    pendingDrafts.delete(action.id);
    // After the page shows the item as it is again.
    if (draft && outcome === "undone")
      queueMicrotask(
        () =>
          void Promise.allSettled(refreshes).then(() => restoreDraft(draft)),
      );
    if (document.querySelector("[data-event-browser]")) {
      refreshDeferredEvents();
      refreshes.push(pendingRefresh);
    }
    const selector = pendingForms.get(action.id);
    pendingForms.delete(action.id);
    const profile = ":is([data-volunteer-profile], [data-application-review])";
    const form =
      (selector &&
        document.querySelector<HTMLFormElement>(`${profile} ${selector}`)) ||
      document.querySelector<HTMLFormElement>(
        `${profile} form:is([data-organizer-status], [data-organizer-role], [data-organizer-rejection])`,
      );
    if (!form) return;
    const refresh = pendingRefresh.then(() => refreshVolunteer(form));
    pendingRefresh = refresh.catch(() => {});
    refreshes.push(pendingRefresh);
  });

  // Never expose actions before submit/change handlers and email consent are ready.
  initVolunteerControls(document);
});
