import alertIcon from "../components/icons/AlertIcon.svg?raw";
import arrowRightIcon from "../components/icons/ArrowRightIcon.svg?raw";
import checkIcon from "../components/icons/CheckIcon.svg?raw";
import chevronDownIcon from "../components/icons/ChevronDownIcon.svg?raw";
import closeIcon from "../components/icons/CloseIcon.svg?raw";
import minimizeIcon from "../components/icons/MinimizeIcon.svg?raw";
import pencilIcon from "../components/icons/PencilIcon.svg?raw";
import timerIcon from "../components/icons/TimerIcon.svg?raw";
import undoIcon from "../components/icons/UndoIcon.svg?raw";
import userPenIcon from "../components/icons/UserPenIcon.svg?raw";
import { setCompactPersonName } from "./compact-person-name";

/** Markup for a waiting change's toast and inline banner, shared by the live
 * page and the UI playground. */
export interface PendingAction {
  id: string;
  endpoint: "events" | "organizer";
  summary: string;
  inlineSummary?: string;
  /** Each setting an event change sets. `from` is left out when new. */
  changes?: { label: string; from?: string; to: string }[];
  /** Which controls on a person's page made it: its banner goes in the
   * matching `data-pending-slot`. */
  area?: "application" | "patrol" | "access";
  verb: string;
  runAt: number;
  createdAt: number;
  actorName: string;
  mine: boolean;
  /** "done" is shown briefly here after the change is made. */
  status: "pending" | "running" | "failed" | "done" | "undone";
  message?: string;
  targets: { target: string; locked: boolean }[];
}

export const targetKind = (target: string) => target.split(":")[0];

export const pendingRemaining = (action: PendingAction, now: number) =>
  Math.max(0, action.runAt - now);
// Usually five minutes, shorter for events about to start.
export const pendingTotal = (action: PendingAction) =>
  Math.max(1, action.runAt - action.createdAt);

function countdown(action: PendingAction, now: number) {
  // Clocks differ by up to a second; never show more than the full delay.
  const seconds = Math.ceil(
    Math.min(pendingTotal(action), pendingRemaining(action, now)) / 1000,
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// "Cancel event" becomes "Cancelling event".
function progressive(verb: string) {
  const [first, ...rest] = verb.split(" ");
  const word =
    first === "Cancel"
      ? "Cancelling"
      : first.endsWith("e")
        ? `${first.slice(0, -1)}ing`
        : `${first}ing`;
  return [word, ...rest].join(" ");
}

// Every summary starts with its verb: "Cancelling Tue, Nov 17" becomes
// "Cancelled Tue, Nov 17" once it is made.
const pastTenses: Record<string, string> = {
  Approving: "Approved",
  Cancelling: "Cancelled",
  Changing: "Changed",
  Deactivating: "Deactivated",
  Deleting: "Deleted",
  Making: "Made",
  Moving: "Moved",
  Reactivating: "Reactivated",
  Rejecting: "Rejected",
  Removing: "Removed",
  Revoking: "Revoked",
  Updating: "Updated",
};
function pastTense(text: string) {
  const [first, ...rest] = text.split(" ");
  const past = pastTenses[first];
  return past ? [past, ...rest].join(" ") : undefined;
}

export const signedOutText = (action: PendingAction, now: number) =>
  pendingRemaining(action, now) > 0
    ? "You are signed out. This change is still made when its timer ends. Sign in again to undo it."
    : "You are signed out. This change is still being made. Sign in again to see it.";

export function pendingButton(className: string, label: string) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

function icon(svg: string, className: string) {
  const wrapper = document.createElement("span");
  wrapper.className = className;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = svg;
  // Keep only the icon: the file's comment and line breaks would add a space.
  wrapper.replaceChildren(...wrapper.querySelectorAll("svg"));
  return wrapper;
}

/** Text, timer and buttons shared by the toast and the inline banner. */
function controls(action: PendingAction, inline: boolean) {
  const buttons = document.createElement("div");
  buttons.className = inline
    ? "pending-inline-actions"
    : "pending-toast-actions";
  const text = document.createElement("p");
  text.className = inline ? "pending-inline-text" : "pending-toast-text";
  // Other organizers see whose change it is.
  const prefix = document.createElement("span");
  prefix.dataset.pendingPrefix = "";
  const actor = document.createElement("strong");
  actor.className = "pending-actor";
  actor.dataset.pendingActor = "";
  const summary = document.createElement("span");
  summary.dataset.pendingSummary = "";
  // The countdown sits just before the buttons that act on it.
  const timer = document.createElement("span");
  timer.className = "pending-timer";
  timer.dataset.pendingClock = "";
  const time = document.createElement("span");
  time.dataset.pendingTimer = "";
  timer.replaceChildren(icon(timerIcon, "pending-timer-icon"), time);
  const message = document.createElement("span");
  message.className = "pending-toast-message";
  message.dataset.pendingMessage = "";
  const phrase = document.createElement("span");
  phrase.className = "pending-phrase";
  phrase.replaceChildren(prefix, actor, summary);
  text.replaceChildren(phrase, message);
  const body = document.createElement("div");
  body.className = "pending-body";
  // A pencil while it waits; an alert once something went wrong.
  body.replaceChildren(
    // Someone else's change shows a person with the pencil.
    icon(
      action.mine ? pencilIcon : userPenIcon,
      "pending-icon pending-icon-waiting",
    ),
    icon(alertIcon, "pending-icon pending-icon-alert"),
    icon(checkIcon, "pending-icon pending-icon-done"),
    icon(undoIcon, "pending-icon pending-icon-undone"),
    text,
  );
  // Undo and the run button live on the item; toasts link to it. Other
  // organizers see the timer but only the author can act on it.
  if (inline && action.mine) {
    const undo = pendingButton("btn pending-undo", "");
    undo.replaceChildren(
      icon(undoIcon, "pending-undo-icon"),
      document.createTextNode("Undo"),
    );
    undo.dataset.pendingUndo = action.id;
    const run = pendingButton("btn btn-primary", `${action.verb} now`);
    run.dataset.pendingRun = action.id;
    // Undo and the run button stay together when the timer moves on phones.
    const pair = document.createElement("span");
    pair.className = "pending-inline-buttons";
    pair.replaceChildren(undo, run);
    buttons.replaceChildren(timer, pair);
  } else buttons.replaceChildren(timer);
  return { body, buttons };
}

/** The page with the changed item's banner: the event, or the person. */
export function pendingHref(action: PendingAction) {
  const event = action.targets.find(
    (entry) => targetKind(entry.target) === "event",
  );
  if (event) return `/events#event-${event.target.slice("event:".length)}`;
  const user = action.targets.find(
    (entry) => targetKind(entry.target) === "user",
  );
  return user
    ? `/volunteers/${encodeURIComponent(user.target.slice("user:".length))}`
    : undefined;
}

export function createPendingToast(action: PendingAction) {
  const element = document.createElement("div");
  element.className = "pending-toast";
  const { body, buttons } = controls(action, false);
  // "View change" gets its own row under the text.
  const footer = document.createElement("div");
  footer.className = "pending-toast-footer";
  const href = pendingHref(action);
  if (href) {
    const link = document.createElement("a");
    link.className = "pending-toast-link";
    link.href = href;
    link.dataset.pendingShow = action.id;
    link.appendChild(document.createTextNode("View change"));
    link.appendChild(icon(arrowRightIcon, "pending-toast-link-icon"));
    // Already on this page: bring its banner into view instead.
    link.addEventListener("click", (event) => {
      const banner = document.querySelector<HTMLElement>(
        `[data-pending-inline="${CSS.escape(action.id)}"]`,
      );
      if (!banner) return;
      event.preventDefault();
      banner.tabIndex = -1;
      banner.scrollIntoView({ block: "center" });
      banner.focus({ preventScroll: true });
    });
    footer.appendChild(link);
  }
  // The timer, or the dismiss button, sits in the top right corner.
  const close = pendingButton("btn btn-quiet pending-toast-close", "");
  close.innerHTML = closeIcon;
  close.setAttribute("aria-label", "Dismiss");
  close.dataset.pendingDismiss = action.id;
  buttons.appendChild(close);
  element.replaceChildren(body, buttons, footer);
  return element;
}

/** A banner on the item at `here`, such as `event:123`. */
export function createPendingInline(action: PendingAction, here: string) {
  const banner = document.createElement("div");
  banner.className = "pending-inline";
  banner.dataset.pendingInline = action.id;
  banner.dataset.pendingHere = here;
  const { body, buttons } = controls(action, true);
  banner.replaceChildren(body, buttons);
  if (action.changes?.length) {
    const list = changeList(action.changes);
    list.id = `pending-changes-${action.id}`;
    const toggle = pendingButton("pending-changes-toggle", "");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-controls", list.id);
    const label = document.createElement("span");
    const count = action.changes.length;
    const show = `Show ${count === 1 ? "change" : `${count} changes`}`;
    label.textContent = "Hide changes";
    toggle.replaceChildren(
      label,
      icon(chevronDownIcon, "pending-changes-icon"),
    );
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      label.textContent = open ? "Hide changes" : show;
      list.hidden = !open;
    });
    body.querySelector(".pending-inline-text")!.appendChild(toggle);
    // Under the summary, before the buttons.
    body.appendChild(list);
  }
  return banner;
}

/** "Volunteer spots: 8 → 10", one setting per row. */
function changeList(changes: NonNullable<PendingAction["changes"]>) {
  const list = document.createElement("ul");
  list.className = "pending-changes";
  for (const change of changes) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "pending-change-label";
    label.textContent = change.label;
    const value = document.createElement("span");
    value.className = "pending-change-value";
    const to = document.createElement("span");
    to.className = "pending-change-to";
    to.textContent = change.to;
    if (change.from !== undefined) {
      const from = document.createElement("span");
      from.className = "pending-change-from";
      // A no-break space holds the arrow to the old value's last word, so
      // it never wraps onto a line of its own.
      from.textContent = `${change.from}\u00a0`;
      from.appendChild(icon(arrowRightIcon, "pending-change-arrow"));
      // Read aloud as "8 to 10".
      const spoken = document.createElement("span");
      spoken.className = "sr-only";
      spoken.textContent = " to ";
      value.replaceChildren(from, spoken, to);
    } else value.replaceChildren(to);
    item.replaceChildren(label, value);
    list.appendChild(item);
  }
  return list;
}

// One animation per item and deadline, so the fill never restarts.
const fills = new WeakMap<
  HTMLElement,
  { deadline: string; animation: Animation }
>();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** The background fill: while it waits, one animation across the whole
 * delay, set to the time already passed. The browser moves it every frame,
 * on the page's clock, whether or not the item is on screen yet. */
function setFill(element: HTMLElement, action: PendingAction, now: number) {
  const current = fills.get(element);
  if (action.status !== "pending") {
    current?.animation.cancel();
    fills.delete(element);
    element.style.setProperty(
      "--progress",
      action.status === "failed" || action.status === "undone" ? "0" : "1",
    );
    return;
  }
  const deadline = `${action.runAt}:${action.createdAt}`;
  if (current?.deadline === deadline) return;
  current?.animation.cancel();
  fills.delete(element);
  const total = pendingTotal(action);
  const elapsed = Math.max(0, total - pendingRemaining(action, now));
  // Off the page or hidden, such as behind the closed chip, the fill layer
  // does not exist to animate. Show where it is now; the next update, once it is on
  // the page, animates on from the same point.
  element.style.setProperty("--progress", String(Math.min(1, elapsed / total)));
  if (!element.isConnected || !element.checkVisibility()) return;
  const animation = element.animate(
    [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
    {
      duration: total,
      fill: "both",
      pseudoElement: "::before",
      // With reduced motion it steps once a second instead.
      easing: reducedMotion.matches
        ? `steps(${Math.max(1, Math.round(total / 1000))}, end)`
        : "linear",
    },
  );
  animation.currentTime = elapsed;
  fills.set(element, { deadline, animation });
}

export function updatePendingItem(
  element: HTMLElement,
  action: PendingAction,
  { inline = false, signedOut = false, now = Date.now() } = {},
) {
  // The short wording fits the item the change is about. Other items it
  // reaches, such as a series' occurrences, need the full summary.
  const here = element.dataset.pendingHere ?? "";
  const primary = action.targets[0]?.target ?? "";
  const short =
    inline &&
    (targetKind(here) === targetKind(primary) ||
      targetKind(primary) === "signup");
  const wording = short
    ? (action.inlineSummary ?? action.summary)
    : action.summary;
  const set = (selector: string, value: string) => {
    const target = element.querySelector<HTMLElement>(selector);
    if (target && target.textContent !== value) target.textContent = value;
  };
  const actor = element.querySelector<HTMLElement>("[data-pending-actor]");
  if (
    actor &&
    !action.mine &&
    actor.dataset.pendingActor !== action.actorName
  ) {
    actor.dataset.pendingActor = action.actorName;
    // Long names shorten as they do in rosters and tables.
    setCompactPersonName(actor, action.actorName);
  }
  const failed = action.status === "failed";
  const done = action.status === "done";
  // Undone here a moment ago; it leaves shortly.
  const undone = action.status === "undone";
  const past = done ? pastTense(wording) : undefined;
  const text = past ?? wording;
  set(
    "[data-pending-prefix]",
    failed
      ? "Change not made: "
      : undone
        ? "Undone: "
        : done && !past
          ? "Change made: "
          : "",
  );
  // "Nico W. is cancelling the patrol…": every summary starts with its verb.
  set(
    "[data-pending-summary]",
    action.mine
      ? text
      : ` ${failed ? "was " : past ? "" : "is "}${text.charAt(0).toLowerCase()}${text.slice(1)}`,
  );
  set(
    "[data-pending-timer]",
    action.status === "running" ? "now" : countdown(action, now),
  );
  // The button says the change is being made; the timer only says when.
  set(
    "[data-pending-run]",
    action.status === "running"
      ? `${progressive(action.verb)}…`
      : `${action.verb} now`,
  );
  const out = signedOut && !failed && !done && !undone;
  set(
    "[data-pending-message]",
    out ? signedOutText(action, now) : (action.message ?? ""),
  );
  element.dataset.status = action.status;
  setFill(element, action, now);
  // A request that could not be confirmed, while the change still waits.
  element.toggleAttribute(
    "data-error",
    action.status !== "failed" && Boolean(action.message) && !out,
  );
  for (const control of element.querySelectorAll<HTMLButtonElement>(
    "[data-pending-undo], [data-pending-run]",
  )) {
    control.hidden = failed || done || undone || out;
    control.disabled = action.status !== "pending";
  }
  const clock = element.querySelector<HTMLElement>("[data-pending-clock]");
  // Signed out after the timer, the message says it is being made.
  if (clock)
    clock.hidden =
      failed || done || undone || (out && pendingRemaining(action, now) === 0);
  const link = element.querySelector<HTMLElement>("[data-pending-show]");
  // Made and failed changes have no banner left to go to.
  if (link) link.hidden = done || failed || undone;
  const close = element.querySelector<HTMLElement>("[data-pending-dismiss]");
  // The X only ever dismisses a failure; nothing else needs it.
  if (close) close.hidden = action.status !== "failed";
}

/** The corner chip that stands in for the toasts until it is opened. */
export function createPendingChip() {
  const chip = pendingButton("pending-chip", "");
  chip.dataset.pendingChip = "";
  // Closed and out of sight until there is a change to show, so neither
  // state flashes before the first update.
  chip.hidden = true;
  chip.setAttribute("aria-expanded", "false");
  const closed = document.createElement("span");
  closed.className = "pending-chip-closed";
  closed.setAttribute("aria-hidden", "true");
  const time = document.createElement("span");
  time.dataset.pendingChipTime = "";
  closed.replaceChildren(
    icon(timerIcon, "pending-chip-timer"),
    icon(checkIcon, "pending-chip-done"),
    icon(alertIcon, "pending-chip-failed"),
    icon(undoIcon, "pending-chip-undone"),
    time,
  );
  const open = document.createElement("span");
  open.className = "pending-chip-open";
  open.replaceChildren(
    icon(minimizeIcon, "pending-chip-icon"),
    document.createTextNode("Minimize pending changes"),
  );
  chip.replaceChildren(closed, open);
  return chip;
}

/** Show the soonest timer, or that the last change was made. */
export function updatePendingChip(
  chip: HTMLElement,
  actions: PendingAction[],
  open: boolean,
  now = Date.now(),
) {
  chip.setAttribute("aria-expanded", String(open));
  // A steady name: screen readers would otherwise hear the time each second.
  if (!open) chip.setAttribute("aria-label", "Show waiting changes");
  else chip.removeAttribute("aria-label");
  const waiting = actions
    .filter((action) => action.status === "pending")
    .sort((a, b) => a.runAt - b.runAt)[0];
  const running = actions.some((action) => action.status === "running");
  const failed = actions.some((action) => action.status === "failed");
  const undone =
    actions.length > 0 && actions.every((action) => action.status === "undone");
  // Nothing left to wait for: a failure outranks a change just made.
  const state =
    waiting || running
      ? "waiting"
      : failed
        ? "failed"
        : undone
          ? "undone"
          : "done";
  chip.dataset.state = state;
  const time = chip.querySelector<HTMLElement>("[data-pending-chip-time]")!;
  const value = waiting
    ? countdown(waiting, now)
    : running
      ? "now"
      : failed
        ? "Not made"
        : undone
          ? "Undone"
          : "Done";
  if (time.textContent !== value) time.textContent = value;
}
