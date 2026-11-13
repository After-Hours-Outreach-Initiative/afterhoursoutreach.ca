import {
  actionEmailNeedsFeedback,
  showActionEmailFeedback,
  type EmailActionResult,
} from "./action-email-feedback";
import {
  createPendingChip,
  createPendingInline,
  createPendingToast,
  pendingRemaining,
  pendingTotal,
  signedOutText as signedOutMessage,
  updatePendingChip,
  updatePendingItem,
  type PendingAction,
} from "./pending-action-view";

const endpoint = "/api/v1/pending-actions";
const pollMs = 15_000;
const warnMs = 30_000;
const doneMs = 2_000;
// Controls that stay usable while the item waits: roster changes do not
// conflict with a waiting edit.
const unlocked =
  ".event-roster, add-attendee, form[data-live-signup], [data-pending-free]";

const region = document.querySelector<HTMLElement>("[data-pending-actions]");
if (region) init(region);

function init(region: HTMLElement) {
  let actions: PendingAction[] = [];
  // The toasts stay behind a corner chip until it is opened, starting
  // minimized on every page load.
  let open = false;
  const setOpen = (value: boolean) => {
    open = value;
  };
  // Failures and blocked edits open the toasts once, so they are seen.
  const alerted = new Set<string>();
  // Server minus browser clock, so every organizer sees the same deadline.
  let clockOffset = 0;
  const requests = new Set<string>();
  // Undone here but not yet confirmed by the server: polls must not bring
  // them back.
  const undoing = new Set<string>();
  const toasts = new Map<string, HTMLElement>();
  // Other organizers' changes show only on their items, except one that
  // blocked an edit here, which also gets a toast.
  const surfaced = new Set<string>();
  // Changes just made, shown as done for a moment before they leave.
  const finished = new Map<string, PendingAction>();
  const warned = new Set<string>();
  // Signed out in this browser: the server still makes the changes on time,
  // but this page can neither make nor undo them.
  let signedOut = false;
  const signedOutError = (response: Response) =>
    response.status === 401 || response.status === 403;
  // Failed automatic runs wait before trying again.
  const retryAfter = new Map<string, number>();
  // Every toast while open, scrolling on its own when there are many.
  const list = document.createElement("div");
  list.className = "pending-list";
  const status = document.createElement("p");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  const chip = createPendingChip();
  region.replaceChildren(status, list, chip);
  // Dims the page while the toasts are open; clicking it minimizes them.
  // It and the spacer persist with the region across page swaps.
  const backdrop = document.querySelector<HTMLElement>(
    "[data-pending-backdrop]",
  )!;
  backdrop.addEventListener("click", () => {
    setOpen(false);
    render();
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      !open ||
      event.defaultPrevented ||
      document.querySelector("dialog[open]")
    )
      return;
    setOpen(false);
    render();
    chip.focus();
  });
  // Room under the page so toasts never hide its end.
  const spacer = document.querySelector<HTMLElement>("[data-pending-spacer]")!;
  new ResizeObserver(() => {
    spacer.style.height =
      list.children.length || !chip.hidden
        ? `${region.offsetHeight + 16}px`
        : "";
  }).observe(region);

  const now = () => Date.now() + clockOffset;
  const remaining = (action: PendingAction) => pendingRemaining(action, now());
  const total = pendingTotal;
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
      if (signedOutError(response)) {
        signedOut = true;
        render();
      }
      if (!response.ok) return;
      signedOut = false;
      const date = Date.parse(response.headers.get("Date") ?? "");
      if (Number.isFinite(date)) clockOffset = date - Date.now();
      const result: { actions: PendingAction[] } = await response.json();
      // Keep local "running" state for requests this page is still making.
      actions = result.actions
        .filter((action) => !undoing.has(action.id))
        .map((action) =>
          requests.has(action.id) ? { ...action, status: "running" } : action,
        );
      for (const action of finished.values())
        if (!actions.some((item) => item.id === action.id))
          actions.push(action);
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
    if (response.ok) document.dispatchEvent(new Event("app-data-changed"));
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

  /** Undo leaves at once; it comes back only if the server refuses. */
  async function undo(id: string): Promise<void> {
    const action = actions.find((item) => item.id === id);
    if (!action || requests.has(id) || action.status !== "pending") return;
    requests.add(id);
    undoing.add(id);
    delete action.message;
    // Undo that reopens the change's form needs no "Undone" state: the form
    // itself shows it, so the change leaves at once.
    const reopening = { id, reopens: false };
    document.dispatchEvent(
      new CustomEvent("pending-action-undoing", { detail: reopening }),
    );
    let leave: number | undefined;
    if (reopening.reopens) {
      actions = actions.filter((item) => item.id !== id);
      render();
    } else {
      // Shown as undone for a moment, unlocked at once; it leaves after.
      action.status = "undone";
      finished.set(id, action);
      render();
      leave = window.setTimeout(() => {
        finished.delete(id);
        actions = actions.filter((item) => item.id !== id);
        render();
      }, doneMs);
    }
    announce("Change undone.");
    const restore = (message?: string) => {
      window.clearTimeout(leave);
      finished.delete(id);
      action.status = "pending";
      if (message) action.message = message;
      if (!actions.some((item) => item.id === id))
        actions = [action, ...actions];
      render();
    };
    try {
      const { response, result } = await post("undo", id);
      if (signedOutError(response)) {
        signedOut = true;
        restore();
        announce(signedOutText(action));
        return;
      }
      if (response.status === 409) {
        // Someone else made or undid it first.
        window.clearTimeout(leave);
        finished.delete(id);
        actions = actions.filter((item) => item.id !== id);
        render();
        if (result.message) announce(result.message);
        void load();
        void announceResolved(action, "done");
        return;
      }
      if (!response.ok)
        throw new Error(result.message || "The change could not be undone.");
      void announceResolved(action, "undone");
    } catch (error) {
      const message =
        error instanceof TypeError
          ? "Undo could not be confirmed. Try again, or the change is made when the timer ends."
          : error instanceof Error
            ? error.message
            : "The change could not be undone.";
      restore(message);
      announce(message);
    } finally {
      requests.delete(id);
      undoing.delete(id);
    }
  }

  async function run(id: string, automatic = false): Promise<void> {
    const action = actions.find((item) => item.id === id);
    if (!action || requests.has(id)) return;
    requests.add(id);
    const previous = action.status;
    action.status = "running";
    delete action.message;
    render();
    try {
      const { response, result } = await post("run", id);
      if (signedOutError(response)) {
        requests.delete(id);
        signedOut = true;
        action.status = previous;
        render();
        if (!automatic) announce(signedOutText(action));
        return;
      }
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
      if (result.status === "failed") {
        action.status = "failed";
        action.message = result.message;
        render();
        announce(`Change not made: ${action.summary}. ${result.message ?? ""}`);
        void announceResolved(action, "done");
        return;
      }
      announce(result.message ?? "Change made.");
      if (!actionEmailNeedsFeedback(result)) {
        // Say it worked before the toast leaves; an email result dialog
        // says so itself.
        action.status = "done";
        finished.set(id, action);
        render();
        void announceResolved(action, "done");
        window.setTimeout(() => {
          finished.delete(id);
          actions = actions.filter((item) => item.id !== id);
          render();
        }, doneMs);
        return;
      }
      // Focus settles on the changed item before any email result opens.
      await resolved(action, "done");
      // A change made on its own waits for the organizer to finish what
      // they are doing in a dialog.
      if (automatic)
        while (document.querySelector("dialog[open]"))
          await new Promise((resolve) => window.setTimeout(resolve, 500));
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
          ? "The change could not be confirmed. Reload to check it."
          : error instanceof Error
            ? error.message
            : "The change could not be made.";
      render();
    }
  }

  async function dismiss(id: string) {
    surfaced.delete(id);
    actions = actions.filter((item) => item.id !== id);
    render();
    await post("dismiss", id).catch(() => {});
  }

  const signedOutText = (action: PendingAction) =>
    signedOutMessage(action, now());

  function update(element: HTMLElement, action: PendingAction, inline = false) {
    updatePendingItem(element, action, { inline, signedOut, now: now() });
  }

  function toast(action: PendingAction) {
    let element = toasts.get(action.id);
    if (!element) {
      element = createPendingToast(action);
      toasts.set(action.id, element);
    }
    update(element, action);
    return element;
  }

  // The author's changes, and others' that blocked an edit here.
  const withToasts = () =>
    actions.filter((action) => action.mine || surfaced.has(action.id));

  function render() {
    const mine = withToasts().sort((a, b) => b.runAt - a.runAt);
    for (const [id, element] of toasts)
      if (!mine.some((action) => action.id === id)) {
        element.remove();
        toasts.delete(id);
      }
    for (const action of mine)
      if (
        (action.status === "failed" || !action.mine) &&
        !alerted.has(action.id)
      ) {
        alerted.add(action.id);
        setOpen(true);
      }
    // Nothing left to show: start minimized again for the next change.
    if (!mine.length) setOpen(false);
    chip.hidden = mine.length === 0;
    updatePendingChip(chip, mine, open, now());
    region.toggleAttribute("data-open", open && mine.length > 0);
    const shown = open ? mine : [];
    const children: HTMLElement[] = shown.map(toast);
    // Move only what changed so focused buttons keep focus.
    children.forEach((child, index) => {
      if (list.children[index] !== child)
        list.insertBefore(child, list.children[index] ?? null);
    });
    while (list.children.length > children.length)
      list.lastElementChild!.remove();
    // On the page now, so their fills can start animating.
    for (const action of shown) update(toasts.get(action.id)!, action);
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
      // Each banner goes in the item's slot for its area, beside the controls
      // that made it, else an unnamed slot, else the top of the item.
      const slots = [
        ...item.querySelectorAll<HTMLElement>("[data-pending-slot]"),
      ].filter((slot) => slot.closest("[data-pending-target]") === item);
      const slotFor = (action: PendingAction) =>
        (action.area &&
          slots.find((slot) =>
            slot.dataset.pendingSlot!.split(/\s+/).includes(action.area!),
          )) ||
        slots.find((slot) => !slot.dataset.pendingSlot) ||
        slots[0] ||
        item;
      const existing = [
        ...item.querySelectorAll<HTMLElement>("[data-pending-inline]"),
      ].filter((banner) => banner.closest("[data-pending-target]") === item);
      for (const banner of existing)
        if (!here.some((action) => action.id === banner.dataset.pendingInline))
          banner.remove();
      const nexts = new Map<HTMLElement, ChildNode | null>();
      for (const action of here) {
        const slot = slotFor(action);
        const next = nexts.has(slot) ? nexts.get(slot)! : slot.firstChild;
        const banner =
          existing.find((found) => found.dataset.pendingInline === action.id) ??
          createPendingInline(action, target);
        // Move only when out of place, so a focused button keeps focus.
        if (banner !== next) slot.insertBefore(banner, next);
        nexts.set(slot, banner.nextSibling);
        update(banner, action, true);
      }
      // A made change still shows its result here, without the lock.
      const locked = here.some(
        (action) =>
          action.status !== "done" &&
          action.status !== "undone" &&
          action.targets.some(
            (entry) => entry.target === target && entry.locked,
          ),
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
      if (signedOut) continue;
      if (action.mine) {
        if ((retryAfter.get(action.id) ?? 0) <= Date.now())
          void run(action.id, true);
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
    updatePendingChip(chip, withToasts(), open, now());
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
    // Going to a change minimizes the toasts, so its banner is not dimmed.
    if (event.target.closest("[data-pending-show]") && open) {
      setOpen(false);
      render();
      return;
    }
    const control = event.target.closest<HTMLElement>(
      "[data-pending-undo], [data-pending-run], [data-pending-dismiss], [data-pending-chip]",
    );
    if (!control) return;
    if (control.dataset.pendingChip !== undefined) {
      setOpen(!open);
      render();
      return;
    }
    if (control.dataset.pendingUndo) void undo(control.dataset.pendingUndo);
    else if (control.dataset.pendingRun) void run(control.dataset.pendingRun);
    else if (control.dataset.pendingDismiss)
      void dismiss(control.dataset.pendingDismiss);
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
  }).observe(document.documentElement, { childList: true, subtree: true });

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
