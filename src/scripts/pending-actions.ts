import closeIcon from "../components/icons/CloseIcon.svg?raw";
import {
  actionEmailNeedsFeedback,
  showActionEmailFeedback,
  type EmailActionResult,
} from "./action-email-feedback";
import "../styles/pending-actions.css";

export interface PendingAction {
  id: string;
  endpoint: "events" | "organizer";
  summary: string;
  inlineSummary?: string;
  verb: string;
  runAt: number;
  createdAt: number;
  actorName: string;
  mine: boolean;
  status: "pending" | "running" | "failed";
  message?: string;
  targets: { target: string; locked: boolean }[];
}

const endpoint = "/api/v1/pending-actions";
const pollMs = 15_000;
const warnMs = 30_000;
// One toast on phones, where three would cover half the screen.
const narrow = window.matchMedia("(width < 40rem)");
const visibleToasts = () => (narrow.matches ? 1 : 3);
// Controls that stay usable while the item waits: roster changes do not
// conflict with a waiting edit.
const unlocked =
  ".event-roster, add-attendee, form[data-live-signup], [data-pending-free]";
const kind = (target: string) => target.split(":")[0];

const region = document.querySelector<HTMLElement>("[data-pending-actions]");
if (region) init(region);

function init(region: HTMLElement) {
  let actions: PendingAction[] = [];
  let expanded = false;
  // Server minus browser clock, so every organizer sees the same deadline.
  let clockOffset = 0;
  const requests = new Set<string>();
  const toasts = new Map<string, HTMLElement>();
  // Other organizers' changes shown as toasts here: ones this page tried to
  // make or that blocked an edit.
  const surfaced = new Set<string>();
  // Failures of other organizers' changes made from this page. The server
  // shows failures only to their author.
  const kept = new Map<string, PendingAction>();
  const warned = new Set<string>();
  // Failed automatic runs wait before trying again.
  const retryAfter = new Map<string, number>();
  const list = document.createElement("div");
  list.style.display = "contents";
  const more = button("pending-more", "");
  more.dataset.pendingMore = "";
  const status = document.createElement("p");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  region.replaceChildren(status, list);
  // Room under the page so toasts never hide its end.
  const spacer = document.createElement("div");
  spacer.setAttribute("aria-hidden", "true");
  document.body.appendChild(spacer);
  new ResizeObserver(() => {
    spacer.style.height = list.children.length
      ? `${region.offsetHeight + 16}px`
      : "";
  }).observe(region);

  const remaining = (action: PendingAction) =>
    Math.max(0, action.runAt - (Date.now() + clockOffset));
  // Usually five minutes, shorter for events about to start.
  const total = (action: PendingAction) =>
    Math.max(1, action.runAt - action.createdAt);
  const countdown = (action: PendingAction) => {
    // Clocks differ by up to a second; never show more than the full delay.
    const seconds = Math.ceil(
      Math.min(total(action), remaining(action)) / 1000,
    );
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const announce = (text: string) => {
    status.textContent = "";
    requestAnimationFrame(() => (status.textContent = text));
  };

  async function load() {
    try {
      const response = await fetch(endpoint, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const date = Date.parse(response.headers.get("Date") ?? "");
      if (Number.isFinite(date)) clockOffset = date - Date.now();
      const result: { actions: PendingAction[] } = await response.json();
      // Keep local "running" state for requests this page is still making.
      actions = result.actions.map((action) =>
        requests.has(action.id) ? { ...action, status: "running" } : action,
      );
      for (const [id, action] of kept)
        if (!actions.some((item) => item.id === id)) actions.push(action);
      render();
    } catch {
      // The next poll tries again.
    }
  }

  async function post(action: "run" | "undo" | "dismiss", id: string) {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id }),
    });
    const result = (await response
      .json()
      .catch(() => ({}))) as EmailActionResult & { status?: string };
    return { response, result };
  }

  function resolved(action: PendingAction, outcome: "done" | "undone") {
    actions = actions.filter((item) => item.id !== action.id);
    render();
    return announceResolved(action, outcome);
  }

  /** Let the page show the item as it is now. Resolves once it has. */
  function announceResolved(action: PendingAction, outcome: "done" | "undone") {
    const refreshes: Promise<unknown>[] = [];
    document.dispatchEvent(
      new CustomEvent("pending-action-resolved", {
        detail: { action, outcome, refreshes },
      }),
    );
    return Promise.allSettled(refreshes);
  }

  async function act(
    id: string,
    kind: "run" | "undo",
    automatic = false,
  ): Promise<void> {
    const action = actions.find((item) => item.id === id);
    if (!action || requests.has(id)) return;
    requests.add(id);
    const previous = action.status;
    action.status = "running";
    delete action.message;
    render();
    try {
      const { response, result } = await post(kind, id);
      if (response.status === 409) {
        // Someone else made or undid it first.
        requests.delete(id);
        if (!automatic && result.message) announce(result.message);
        await load();
        void announceResolved(action, "done");
        return;
      }
      if (!response.ok)
        throw new Error(result.message || "The change could not be made.");
      requests.delete(id);
      if (kind === "undo") {
        announce("Change undone.");
        void resolved(action, "undone");
        return;
      }
      if (result.status === "failed") {
        action.status = "failed";
        action.message = result.message;
        if (!action.mine) {
          surfaced.add(id);
          kept.set(id, action);
        }
        render();
        announce(`${action.summary} failed. ${result.message ?? ""}`);
        void announceResolved(action, "done");
        return;
      }
      announce(result.message ?? "Change made.");
      // Focus settles on the changed item before any email result opens.
      await resolved(action, "done");
      // A change made on its own waits for the organizer to finish what
      // they are doing in a dialog.
      if (automatic)
        while (document.querySelector("dialog[open]"))
          await new Promise((resolve) => window.setTimeout(resolve, 500));
      if (actionEmailNeedsFeedback(result))
        showActionEmailFeedback(
          "Change made",
          `/api/v1/${action.endpoint}/action`,
          result,
        );
    } catch (error) {
      requests.delete(id);
      if (automatic) retryAfter.set(id, Date.now() + pollMs);
      action.status = previous;
      action.message =
        error instanceof TypeError
          ? kind === "undo"
            ? "Undo could not be confirmed. Try again, or the change is made when the timer ends."
            : "The change could not be confirmed. Reload to check it."
          : error instanceof Error
            ? error.message
            : "The change could not be made.";
      render();
    }
  }

  async function dismiss(id: string) {
    kept.delete(id);
    surfaced.delete(id);
    actions = actions.filter((item) => item.id !== id);
    render();
    await post("dismiss", id).catch(() => {});
  }

  function button(className: string, label: string) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    return element;
  }

  /** Text, timer and buttons shared by the toast and the inline banner. */
  function controls(action: PendingAction, inline: boolean) {
    const text = document.createElement("p");
    text.className = inline ? "pending-inline-text" : "pending-toast-text";
    const summary = document.createElement("span");
    summary.dataset.pendingSummary = "";
    const message = document.createElement("span");
    message.className = "pending-toast-message";
    message.dataset.pendingMessage = "";
    text.replaceChildren(summary, message);
    const buttons = document.createElement("div");
    buttons.className = inline
      ? "pending-inline-actions"
      : "pending-toast-actions";
    const undo = button("btn btn-quiet", "Undo");
    undo.dataset.pendingUndo = action.id;
    // The button counts down to when it happens on its own; pressing it skips
    // the wait. Its fill grows as the time runs out.
    const run = button("btn btn-primary pending-run", "");
    run.dataset.pendingRun = action.id;
    run.title = `${action.verb} now`;
    // A steady name: screen readers would otherwise hear it change each second.
    run.setAttribute("aria-label", `${action.verb} now`);
    // The fill starts where it should be instead of sweeping there.
    run.dataset.fresh = "";
    const fill = document.createElement("span");
    fill.className = "pending-run-fill";
    fill.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "pending-run-label";
    label.setAttribute("aria-hidden", "true");
    label.dataset.pendingTimer = "";
    run.replaceChildren(fill, label);
    buttons.replaceChildren(undo, run);
    return { text, buttons };
  }

  // "Cancel event" becomes "Cancelling event".
  const progressive = (verb: string) => {
    const [first, ...rest] = verb.split(" ");
    const word =
      first === "Cancel"
        ? "Cancelling"
        : first.endsWith("e")
          ? `${first.slice(0, -1)}ing`
          : `${first}ing`;
    return [word, ...rest].join(" ");
  };

  function update(element: HTMLElement, action: PendingAction, inline = false) {
    // The short wording fits the item the change is about. Other items it
    // reaches, such as a series' occurrences, need the full summary.
    const here = element.dataset.pendingHere ?? "";
    const primary = action.targets[0]?.target ?? "";
    const short =
      inline && (kind(here) === kind(primary) || kind(primary) === "signup");
    const text = short
      ? (action.inlineSummary ?? action.summary)
      : action.summary;
    const summary = action.mine ? text : `${action.actorName}: ${text}`;
    const set = (selector: string, value: string) => {
      const target = element.querySelector<HTMLElement>(selector);
      if (target && target.textContent !== value) target.textContent = value;
    };
    set("[data-pending-summary]", summary);
    set(
      "[data-pending-timer]",
      action.status === "running"
        ? `${progressive(action.verb)}…`
        : `${action.verb} in ${countdown(action)}`,
    );
    const run = element.querySelector<HTMLElement>("[data-pending-run]");
    run?.style.setProperty(
      "--progress",
      action.status === "running"
        ? "1"
        : String(Math.max(0, 1 - remaining(action) / total(action))),
    );
    if (run?.dataset.fresh !== undefined)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => delete run.dataset.fresh),
      );
    set("[data-pending-message]", action.message ?? "");
    element.dataset.status = action.status;
    for (const control of element.querySelectorAll<HTMLButtonElement>(
      "[data-pending-undo], [data-pending-run]",
    )) {
      control.hidden = action.status === "failed";
      control.disabled = action.status !== "pending";
    }
    const close = element.querySelector<HTMLElement>("[data-pending-dismiss]");
    if (close) close.hidden = action.status !== "failed";
  }

  function toast(action: PendingAction) {
    let element = toasts.get(action.id);
    if (!element) {
      element = document.createElement("div");
      element.className = "pending-toast";
      const { text, buttons } = controls(action, false);
      const close = button("btn btn-quiet pending-toast-close", "");
      close.innerHTML = closeIcon;
      close.setAttribute("aria-label", "Dismiss");
      close.dataset.pendingDismiss = action.id;
      buttons.appendChild(close);
      element.replaceChildren(text, buttons);
      toasts.set(action.id, element);
    }
    update(element, action);
    return element;
  }

  function render() {
    const mine = actions
      .filter((action) => action.mine || surfaced.has(action.id))
      .sort((a, b) => b.runAt - a.runAt);
    const visible = visibleToasts();
    for (const [id, element] of toasts)
      if (!mine.some((action) => action.id === id)) {
        element.remove();
        toasts.delete(id);
      }
    if (mine.length <= visible) expanded = false;
    const shown = expanded ? mine : mine.slice(0, visible);
    const children: HTMLElement[] = shown.map(toast);
    if (mine.length > visible) {
      more.textContent = expanded
        ? "Show fewer"
        : `${mine.length - visible} more`;
      more.setAttribute("aria-expanded", String(expanded));
      children.push(more);
    }
    // Move only what changed so focused buttons keep focus.
    children.forEach((child, index) => {
      if (list.children[index] !== child)
        list.insertBefore(child, list.children[index] ?? null);
    });
    while (list.children.length > children.length)
      list.lastElementChild!.remove();
    decorate();
  }

  /** Show the timer on the items it changes, and lock them while it runs. */
  function decorate() {
    for (const item of document.querySelectorAll<HTMLElement>(
      "[data-pending-target]",
    )) {
      const target = item.dataset.pendingTarget!;
      // Every waiting change here, soonest first.
      const here = actions
        .filter(
          (action) =>
            action.status !== "failed" &&
            action.targets.some((entry) => entry.target === target),
        )
        .sort((a, b) => a.runAt - b.runAt);
      for (const banner of item.querySelectorAll<HTMLElement>(
        ":scope > [data-pending-inline]",
      ))
        if (!here.some((action) => action.id === banner.dataset.pendingInline))
          banner.remove();
      let next: ChildNode | null = item.firstChild;
      for (const action of here) {
        let banner = item.querySelector<HTMLElement>(
          `:scope > [data-pending-inline="${CSS.escape(action.id)}"]`,
        );
        if (!banner) {
          banner = document.createElement("div");
          banner.className = "pending-inline";
          banner.dataset.pendingInline = action.id;
          banner.dataset.pendingHere = target;
          const { text, buttons } = controls(action, true);
          banner.replaceChildren(text, buttons);
        }
        // Move only when out of place, so a focused button keeps focus.
        if (banner !== next) item.insertBefore(banner, next);
        next = banner.nextSibling;
        update(banner, action, true);
      }
      const locked = here.some((action) =>
        action.targets.some((entry) => entry.target === target && entry.locked),
      );
      if (locked)
        for (const control of item.querySelectorAll<
          HTMLElement & { disabled: boolean }
        >("button, input, select, textarea")) {
          if (
            control.closest("[data-pending-inline]") ||
            control.closest(unlocked) ||
            control.disabled
          )
            continue;
          control.disabled = true;
          control.dataset.pendingDisabled = "";
        }
      else
        for (const control of item.querySelectorAll<
          HTMLElement & { disabled: boolean }
        >("[data-pending-disabled]")) {
          control.disabled = false;
          delete control.dataset.pendingDisabled;
        }
    }
  }

  function tick() {
    for (const action of actions) {
      if (action.status !== "pending") continue;
      // Warn screen reader users before their change is made.
      if (
        action.mine &&
        remaining(action) <= warnMs &&
        !warned.has(action.id)
      ) {
        warned.add(action.id);
        if (remaining(action) > 5_000)
          announce(`${action.summary} in 30 seconds. Undo to stop it.`);
      }
      if (remaining(action) > 0) continue;
      // The author's page makes the change on time; others wait for it.
      if (action.mine) {
        if ((retryAfter.get(action.id) ?? 0) <= Date.now())
          void act(action.id, "run", true);
      } else if (!requests.has("load")) {
        requests.add("load");
        window.setTimeout(() => {
          requests.delete("load");
          void load();
        }, 3_000);
      }
    }
    for (const action of actions) {
      const element = toasts.get(action.id);
      if (element) update(element, action);
    }
    for (const banner of document.querySelectorAll<HTMLElement>(
      "[data-pending-inline]",
    )) {
      const action = actions.find(
        (item) => item.id === banner.dataset.pendingInline,
      );
      if (action) update(banner, action, true);
    }
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>(
      "[data-pending-undo], [data-pending-run], [data-pending-dismiss], [data-pending-more]",
    );
    if (!control) return;
    if (control.dataset.pendingUndo)
      void act(control.dataset.pendingUndo, "undo");
    else if (control.dataset.pendingRun)
      void act(control.dataset.pendingRun, "run");
    else if (control.dataset.pendingDismiss)
      void dismiss(control.dataset.pendingDismiss);
    else {
      expanded = !expanded;
      render();
    }
  });
  document.addEventListener("pending-action-added", (event) => {
    const action = (event as CustomEvent<PendingAction>).detail;
    actions = [action, ...actions.filter((item) => item.id !== action.id)];
    render();
    const minutes = Math.ceil(total(action) / 60_000);
    announce(
      `${action.summary}. Undo within ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
  });
  // An edit was refused because of this waiting change: offer it here, even
  // where the page has no item to show it on.
  document.addEventListener("pending-action-blocked", (event) => {
    surfaced.add((event as CustomEvent<{ id: string }>).detail.id);
    void load();
  });
  narrow.addEventListener("change", () => {
    expanded = false;
    render();
  });
  // Pages replace items as they refresh; put the timer back on new ones.
  let queued = false;
  new MutationObserver((mutations) => {
    if (
      queued ||
      mutations.every((mutation) =>
        (mutation.target as Element).closest?.(
          "[data-pending-inline], [data-pending-actions]",
        ),
      )
    )
      return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      decorate();
    });
  }).observe(document.body, { childList: true, subtree: true });

  let poll: number | undefined;
  const startPolling = () => {
    window.clearInterval(poll);
    poll = window.setInterval(load, pollMs);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) window.clearInterval(poll);
    else {
      void load();
      startPolling();
    }
  });
  window.setInterval(tick, 1_000);
  startPolling();
  void load();
}
