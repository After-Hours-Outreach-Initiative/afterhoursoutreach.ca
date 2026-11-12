import {
  createPendingChip,
  createPendingInline,
  createPendingToast,
  updatePendingChip,
  updatePendingItem,
  type PendingAction,
} from "../../scripts/pending-action-view";
import {
  baseChange,
  fullDelay,
  timerScenarios,
  type TimerScenario,
} from "./pending-timer-fixtures";

interface Mounted {
  element: HTMLElement;
  action: PendingAction;
  inline: boolean;
  signedOut: boolean;
}

const root = document.querySelector<HTMLElement>("[data-ui-timer-playground]");
if (root) init(root);

function init(root: HTMLElement) {
  let mounted: Mounted[] = [];
  let chips: (() => void)[] = [];
  const viewElement = root.querySelector("[data-ui-timer-view]");
  const viewAs = viewElement instanceof HTMLSelectElement ? viewElement : null;

  function action(
    scenario: TimerScenario,
    fixture: TimerScenario["changes"][number],
    start: number,
    mine: boolean,
  ): PendingAction {
    const { left, delay = fullDelay, blocked: _, ...rest } = fixture;
    const runAt = start + left;
    return {
      ...baseChange,
      ...rest,
      id: `${scenario.id}-${fixture.id ?? "change"}-${mine ? "mine" : "other"}`,
      mine: mine && fixture.mine !== false,
      runAt,
      createdAt: runAt - delay,
    };
  }

  /** The page's toast column, placed in the flow. */
  function toasts(scenario: TimerScenario, actions: PendingAction[]) {
    const frame = document.createElement("div");
    frame.className = "ui-timer-toasts";
    // Newest first, as on the page.
    const sorted = [...actions].sort((a, b) => b.runAt - a.runAt);
    sorted.forEach((item) => {
      const toast = createPendingToast(item);
      frame.appendChild(toast);
      mounted.push({
        element: toast,
        action: item,
        inline: false,
        signedOut: Boolean(scenario.signedOut),
      });
    });
    if (scenario.view === "chip") {
      // The page's corner chip: toasts show only while it is open.
      let open = Boolean(scenario.open);
      const chip = createPendingChip();
      const items = mounted.filter((entry) => frame.contains(entry.element));
      const refresh = () => {
        const left = items.filter((entry) => entry.element.isConnected);
        chip.hidden = left.length === 0;
        updatePendingChip(
          chip,
          left.map((entry) => entry.action),
          open,
          Date.now(),
        );
        frame
          .querySelectorAll<HTMLElement>(".pending-toast")
          .forEach((element) =>
            element.classList.toggle("ui-timer-closed", !open),
          );
      };
      chip.addEventListener("click", () => {
        open = !open;
        refresh();
        // Shown now, so their fills can start animating.
        tick();
      });
      frame.appendChild(chip);
      chips.push(refresh);
      refresh();
    }
    return frame;
  }

  /** The item a change is about, with its banners, soonest first. */
  function item(scenario: TimerScenario, actions: PendingAction[]) {
    const { here, title, detail } = scenario.item!;
    const frame = document.createElement("div");
    frame.className = "ui-timer-item";
    for (const change of [...actions].sort((a, b) => a.runAt - b.runAt)) {
      const banner = createPendingInline(change, here);
      frame.appendChild(banner);
      mounted.push({
        element: banner,
        action: change,
        inline: true,
        signedOut: false,
      });
    }
    const heading = document.createElement("p");
    heading.className = "ui-timer-item-heading";
    heading.textContent = title;
    const description = document.createElement("p");
    description.textContent = detail;
    frame.appendChild(heading);
    frame.appendChild(description);
    return frame;
  }

  function view(scenario: TimerScenario, start: number, mine: boolean) {
    const make = () =>
      scenario.changes.map((fixture) => action(scenario, fixture, start, mine));
    const frame = document.createElement("div");
    frame.className = "ui-timer-view";
    // The toast and the banner are separate copies, as on the page. Other
    // organizers' changes get a toast only when they refused an edit.
    if (scenario.view !== "inline") {
      const shown = make().filter(
        (change, index) => change.mine || scenario.changes[index].blocked,
      );
      if (shown.length) frame.appendChild(toasts(scenario, shown));
      else if (scenario.view === "toast") {
        const note = document.createElement("p");
        note.className = "ui-timer-note";
        note.textContent =
          "No toast. Other organizers see this change only on its item.";
        frame.appendChild(note);
      }
    }
    if (scenario.view === "inline" || scenario.view === "both")
      frame.appendChild(item(scenario, make()));
    return frame;
  }

  function start() {
    mounted = [];
    chips = [];
    const now = Date.now();
    const mine = viewAs?.value !== "other";
    for (const scenario of timerScenarios) {
      const slot = root.querySelector<HTMLElement>(
        `[data-ui-timer-scenario="${scenario.id}"]`,
      );
      if (!slot) continue;
      slot.classList.toggle("ui-timer-narrow", Boolean(scenario.narrow));
      if (!scenario.compare) {
        slot.replaceChildren(view(scenario, now, mine));
        continue;
      }
      const columns = [true, false].map((author) => {
        const column = document.createElement("div");
        column.className = "ui-timer-column";
        const label = document.createElement("p");
        label.className = "ui-timer-label";
        label.textContent = author ? "You" : "Other organizers";
        column.appendChild(label);
        column.appendChild(view(scenario, now, author));
        return column;
      });
      slot.replaceChildren(...columns);
    }
    tick();
  }

  /** Being made briefly, then made for two seconds, as on the page. */
  function finish(item: Mounted) {
    item.action.status = "running";
    window.setTimeout(() => {
      item.action.status = "done";
      tick();
      window.setTimeout(() => item.element.remove(), 2000);
    }, 700);
  }

  function tick() {
    const now = Date.now();
    for (const refresh of chips) refresh();
    for (const item of mounted) {
      // The author's page makes the change when its timer ends.
      if (
        item.action.mine &&
        item.action.status === "pending" &&
        !item.signedOut &&
        item.action.runAt <= now
      )
        finish(item);
      if (item.element.isConnected)
        updatePendingItem(item.element, item.action, {
          inline: item.inline,
          signedOut: item.signedOut,
          now,
        });
    }
  }

  // Buttons act on the preview only: undo removes it, the run button shows
  // the change being made, and dismiss clears a failure.
  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>(
      "[data-pending-undo], [data-pending-run], [data-pending-dismiss]",
    );
    const item = mounted.find((entry) => entry.element.contains(control));
    if (!control || !item) return;
    if (control.dataset.pendingRun) {
      finish(item);
      tick();
    } else if (control.dataset.pendingUndo) {
      // Undone for two seconds, as on the page, then gone.
      item.action.status = "undone";
      tick();
      window.setTimeout(() => item.element.remove(), 2000);
    } else item.element.remove();
  });
  root
    .querySelector("[data-ui-timer-restart]")
    ?.addEventListener("click", start);
  viewAs?.addEventListener("change", start);
  start();
  window.setInterval(tick, 1000);
}
