import { compactPersonDisplayName } from "../../data/person-name";
import type { PendingAction } from "../../scripts/pending-action-view";

/** A waiting change, timed from when the playground (re)starts. Wording
 * mirrors `describe` in src/server/pending-actions.ts. */
export interface TimerFixture extends Partial<
  Omit<PendingAction, "runAt" | "createdAt">
> {
  /** Milliseconds left on the timer. */
  left: number;
  /** The full delay; five minutes unless an event is about to start. */
  delay?: number;
  /** Another organizer's change that refused an edit, so it also shows as a
   * toast. Otherwise other organizers see it only on its item. */
  blocked?: boolean;
}

export interface TimerItem {
  /** The item's pending target, such as `event:patrol`. */
  here: string;
  title: string;
  detail: string;
}

export interface TimerScenario {
  id: string;
  title: string;
  description: string;
  /** Where it appears: the toast, the banner on an item, or both. */
  view: "toast" | "inline" | "both" | "chip";
  /** For the corner chip: whether its toasts start open. */
  open?: boolean;
  item?: TimerItem;
  /** Show the author's and another organizer's view side by side. */
  compare?: boolean;
  signedOut?: boolean;
  /** Phone width, where toasts span the screen. */
  narrow?: boolean;
  changes: TimerFixture[];
}

const minute = 60_000;
export const fullDelay = 5 * minute;

// Server summaries shorten names the same way rosters do.
const casey = compactPersonDisplayName("Casey B.");
const longName = compactPersonDisplayName(
  "Alexanderthegreatesteverlastingunbrokenvolunteername W.",
);

const patrol: TimerItem = {
  here: "event:patrol",
  title: "Tue, Nov 17, 2026, 6:00 p.m.",
  detail: "Patrol · Strathcona Community Centre",
};
const orientation: TimerItem = {
  here: "event:orientation",
  title: "Thu, Nov 19, 2026, 6:00 p.m.",
  detail: "Orientation + Patrol · Strathcona Community Centre",
};
const occurrence: TimerItem = {
  here: "event:occurrence",
  title: "Tue, Dec 1, 2026, 6:00 p.m.",
  detail: "Patrol · Every week · Strathcona Community Centre",
};
const application: TimerItem = {
  here: "user:casey",
  title: "Casey B.",
  detail: "Application review · Ready for review",
};
const profile: TimerItem = {
  here: "user:casey",
  title: "Casey B.",
  detail: "Volunteer profile · Outreach volunteer",
};

export const baseChange: PendingAction = {
  id: "change",
  endpoint: "events",
  summary: "Cancelling the event on Tue, Nov 17",
  inlineSummary: "Cancelling this event",
  verb: "Cancel event",
  runAt: 0,
  createdAt: 0,
  actorName: "Nico W.",
  mine: true,
  status: "pending",
  targets: [{ target: "event:patrol", locked: true }],
};

const person = (summary: string, verb: string): Omit<TimerFixture, "left"> => ({
  endpoint: "organizer",
  summary,
  inlineSummary: undefined,
  verb,
  targets: [{ target: "user:casey", locked: true }],
});
const series = (
  summary: string,
  inlineSummary: string,
  verb: string,
): Omit<TimerFixture, "left"> => ({
  summary,
  inlineSummary,
  verb,
  targets: [
    { target: "series:tuesday", locked: true },
    { target: "event:occurrence", locked: true },
  ],
});

export const timerSections = [
  {
    id: "chip",
    title: "Corner chip",
    description:
      "The toasts stay behind a chip with the soonest timer until it is opened. Failures and refused edits open them on their own.",
  },
  {
    id: "states",
    title: "States",
    description:
      "One change through its life. Undo and the run button are on the item; the toast links to it.",
  },
  {
    id: "compare",
    title: "How other organizers see it",
    description:
      "Everyone else sees the change on its item, with its author and timer but no buttons. They get a toast only when it refuses their edit.",
  },
  {
    id: "events",
    title: "Event changes",
    description:
      "Every event change that waits, as a toast and on the event card.",
  },
  {
    id: "people",
    title: "Application and volunteer changes",
    description:
      "Approvals and access changes, as a toast and on the person's page.",
  },
  {
    id: "difficult",
    title: "Difficult input",
    description: "Long names and text, short delays, many changes and phones.",
  },
] as const;

type Section = (typeof timerSections)[number]["id"];

export const timerScenarios: (TimerScenario & { section: Section })[] = [
  {
    section: "chip",
    id: "chip-closed",
    title: "Closed",
    description: "The soonest of three timers. Open it to see the toasts.",
    view: "chip",
    changes: [
      { id: "a", left: 4 * minute },
      {
        id: "b",
        left: 90_000,
        ...person(`Approving ${casey} for patrols`, "Approve"),
      },
      {
        id: "c",
        left: 3 * minute,
        summary: "Cancelling the event on Tue, Dec 15",
      },
    ],
  },
  {
    section: "chip",
    id: "chip-open",
    title: "Open",
    description: "The toasts above the chip, which now minimizes them.",
    view: "chip",
    open: true,
    changes: [
      { id: "a", left: 4 * minute },
      {
        id: "b",
        left: 90_000,
        ...person(`Approving ${casey} for patrols`, "Approve"),
      },
    ],
  },
  {
    section: "chip",
    id: "chip-done",
    title: "Just made",
    description:
      "Nothing left waiting: a check for two seconds, then the chip leaves.",
    view: "chip",
    changes: [{ left: 0, status: "done" }],
  },
  {
    section: "chip",
    id: "chip-failed",
    title: "Failed, minimized",
    description:
      "A failure opens the toasts; minimized again, the chip says so.",
    view: "chip",
    changes: [
      {
        left: 0,
        status: "failed",
        message: "This event changed. Reload before editing it.",
      },
    ],
  },
  {
    section: "states",
    id: "waiting",
    title: "Just made",
    description: "The full five minutes.",
    view: "both",
    item: patrol,
    changes: [{ left: fullDelay }],
  },
  {
    section: "states",
    id: "last-seconds",
    title: "Last seconds",
    description: "Ends a few seconds after the playground starts.",
    view: "both",
    item: patrol,
    changes: [{ left: 8_000 }],
  },
  {
    section: "states",
    id: "running",
    title: "Being made",
    description: "After the timer ends or the button is pressed.",
    view: "both",
    item: patrol,
    changes: [{ left: 0, status: "running" }],
  },
  {
    section: "states",
    id: "done",
    title: "Made",
    description:
      "The wording turns past tense for two seconds, then the toast and banner leave. Skipped when an email result dialog opens instead.",
    view: "both",
    item: patrol,
    changes: [{ left: 0, status: "done" }],
  },
  {
    section: "states",
    id: "undone",
    title: "Undone",
    description:
      "Shown for two seconds after Undo, then the toast and banner leave. The item unlocks straight away.",
    view: "both",
    item: patrol,
    changes: [{ left: 3 * minute, status: "undone" }],
  },
  {
    section: "states",
    id: "undo-unconfirmed",
    title: "Undo not confirmed",
    description: "The undo request failed, so the change came back.",
    view: "both",
    item: patrol,
    changes: [
      {
        left: 3 * minute,
        message:
          "Undo could not be confirmed. Try again, or the change is made when the timer ends.",
      },
    ],
  },
  {
    section: "states",
    id: "failed",
    title: "Failed",
    description: "The change could not be made. Only dismiss remains.",
    view: "toast",
    changes: [
      {
        left: 0,
        status: "failed",
        message: "This event changed. Reload before editing it.",
      },
    ],
  },
  {
    section: "states",
    id: "signed-out",
    title: "Signed out while waiting",
    description: "The server still makes the change on time.",
    view: "toast",
    signedOut: true,
    changes: [{ left: 2 * minute }],
  },
  {
    section: "states",
    id: "signed-out-due",
    title: "Signed out after the timer",
    description: "The change is being made without this page.",
    view: "toast",
    signedOut: true,
    changes: [{ left: 0 }],
  },
  {
    section: "compare",
    id: "compare-waiting",
    title: "Waiting",
    description: "Only the author can undo it or make it now.",
    view: "both",
    item: patrol,
    compare: true,
    changes: [{ left: 3 * minute }],
  },
  {
    section: "compare",
    id: "compare-running",
    title: "Being made",
    description: "Both see it being made.",
    view: "both",
    item: patrol,
    compare: true,
    changes: [{ left: 0, status: "running" }],
  },
  {
    section: "compare",
    id: "compare-approval",
    title: "Approval on the application",
    description: "Another organizer reviewing the same application.",
    view: "inline",
    item: application,
    compare: true,
    changes: [
      {
        left: 2 * minute,
        ...person(`Approving ${casey}'s application`, "Approve"),
      },
    ],
  },
  {
    section: "compare",
    id: "compare-blocked",
    title: "Edit refused",
    description:
      "Another organizer edits the event while it waits. The edit is refused and the waiting change appears as a toast, so they can see why.",
    view: "toast",
    compare: true,
    changes: [{ left: 2 * minute, blocked: true }],
  },
  {
    section: "events",
    id: "event-fields",
    title: "Editing an event",
    description: "Up to three changed fields are named.",
    view: "both",
    item: patrol,
    changes: [
      {
        left: 4 * minute,
        summary:
          "Changing the start time and spots of the event on Tue, Nov 17",
        inlineSummary: "Changing the start time and spots",
        verb: "Change",
      },
    ],
  },
  {
    section: "events",
    id: "event-save",
    title: "Editing many fields",
    description: "More than three fields read as updating the event.",
    view: "both",
    item: patrol,
    changes: [
      {
        left: 4 * minute,
        summary: "Updating the event on Tue, Nov 17",
        inlineSummary: "Updating this event",
        verb: "Update",
      },
    ],
  },
  {
    section: "events",
    id: "event-cancel",
    title: "Cancelling an event",
    description:
      "Cancel names what it cancels, so it never reads as cancelling the timer.",
    view: "both",
    item: patrol,
    changes: [{ left: 4 * minute }],
  },
  {
    section: "events",
    id: "event-delete",
    title: "Deleting an orientation",
    description: "Patrols and orientations both read as events.",
    view: "both",
    item: orientation,
    changes: [
      {
        left: 4 * minute,
        summary: "Deleting the event on Thu, Nov 19",
        inlineSummary: "Deleting this event",
        verb: "Delete",
        targets: [{ target: "event:orientation", locked: true }],
      },
    ],
  },
  {
    section: "events",
    id: "bulk",
    title: "Editing selected events",
    description: "Each selected card says how many it changes.",
    view: "both",
    item: patrol,
    changes: [
      {
        left: 4 * minute,
        summary: "Changing the visibility of 4 events",
        inlineSummary: "Changing the visibility of 4 events",
        verb: "Change",
      },
    ],
  },
  {
    section: "events",
    id: "series-from",
    title: "Editing this and following events",
    description: "Its dates show the full summary.",
    view: "both",
    item: occurrence,
    changes: [
      {
        left: 4 * minute,
        ...series(
          "Updating Tue, Dec 1 and following events",
          "Updating Tue, Dec 1 and following events",
          "Update",
        ),
      },
    ],
  },
  {
    section: "events",
    id: "series-save",
    title: "Editing all occurrences",
    description: "Shortening a recurring event shows on the dates it drops.",
    view: "both",
    item: occurrence,
    changes: [
      {
        left: 4 * minute,
        ...series(
          "Updating all occurrences of this recurring event",
          "Updating all occurrences",
          "Update",
        ),
      },
    ],
  },
  {
    section: "events",
    id: "series-stop",
    title: "Cancelling this and following events",
    description: "From one date onwards.",
    view: "both",
    item: occurrence,
    changes: [
      {
        left: 4 * minute,
        ...series(
          "Cancelling Tue, Dec 1 and following events",
          "Cancelling Tue, Dec 1 and following events",
          "Cancel events",
        ),
      },
    ],
  },
  {
    section: "events",
    id: "series-delete",
    title: "Deleting all occurrences",
    description: "Every remaining date.",
    view: "both",
    item: occurrence,
    changes: [
      {
        left: 4 * minute,
        ...series(
          "Deleting all occurrences of this recurring event",
          "Deleting all occurrences",
          "Delete",
        ),
      },
    ],
  },
  {
    section: "events",
    id: "signup-remove",
    title: "Removing a volunteer",
    description: "The rest of the event stays editable.",
    view: "both",
    item: patrol,
    changes: [
      {
        left: 4 * minute,
        summary: `Removing ${casey} from the event on Tue, Nov 17`,
        inlineSummary: `Removing ${casey}`,
        verb: "Remove",
        targets: [
          { target: "signup:casey", locked: true },
          { target: "event:patrol", locked: false },
        ],
      },
    ],
  },
  {
    section: "events",
    id: "signup-move",
    title: "Moving a volunteer",
    description: "Names the event they are moving to.",
    view: "both",
    item: patrol,
    changes: [
      {
        left: 4 * minute,
        summary: `Moving ${casey} to the event on Tue, Dec 1`,
        inlineSummary: undefined,
        verb: "Move",
        targets: [
          { target: "signup:casey", locked: true },
          { target: "event:patrol", locked: false },
        ],
      },
    ],
  },
  {
    section: "people",
    id: "approve-application",
    title: "Approving an application",
    description: "From the application review.",
    view: "both",
    item: application,
    changes: [
      {
        left: 4 * minute,
        ...person(`Approving ${casey}'s application`, "Approve"),
      },
    ],
  },
  {
    section: "people",
    id: "reject-application",
    title: "Rejecting an application",
    description: "From the application review.",
    view: "both",
    item: application,
    changes: [
      {
        left: 4 * minute,
        ...person(`Rejecting ${casey}'s application`, "Reject"),
      },
    ],
  },
  {
    section: "people",
    id: "approve-patrols",
    title: "Approving for patrols",
    description: "After orientation.",
    view: "both",
    item: profile,
    changes: [
      {
        left: 4 * minute,
        ...person(`Approving ${casey} for patrols`, "Approve"),
      },
    ],
  },
  {
    section: "people",
    id: "revoke-application",
    title: "Revoking application approval",
    description: "From the volunteer's access settings.",
    view: "both",
    item: profile,
    changes: [
      {
        left: 4 * minute,
        ...person(`Revoking ${casey}'s application approval`, "Revoke"),
      },
    ],
  },
  {
    section: "people",
    id: "revoke-patrols",
    title: "Revoking patrol approval",
    description: "From the volunteer's access settings.",
    view: "both",
    item: profile,
    changes: [
      {
        left: 4 * minute,
        ...person(`Revoking ${casey}'s patrol approval`, "Revoke"),
      },
    ],
  },
  {
    section: "people",
    id: "role-organizer",
    title: "Making someone an organizer",
    description: "Or back to a volunteer.",
    view: "both",
    item: profile,
    changes: [
      { left: 4 * minute, ...person(`Making ${casey} an organizer`, "Make") },
    ],
  },
  {
    section: "people",
    id: "deactivate",
    title: "Deactivating",
    description: "Reactivating reads the same way.",
    view: "both",
    item: profile,
    changes: [
      { left: 4 * minute, ...person(`Deactivating ${casey}`, "Deactivate") },
    ],
  },
  {
    section: "people",
    id: "access",
    title: "Other access changes",
    description: "When no single change describes it.",
    view: "both",
    item: profile,
    changes: [
      { left: 4 * minute, ...person(`Updating ${casey}'s access`, "Update") },
    ],
  },
  {
    section: "difficult",
    id: "long-names",
    title: "Long names",
    description:
      "Shortened to 20 characters, keeping the initial, as in rosters. Hover the author's name for the full one.",
    view: "both",
    item: application,
    compare: true,
    changes: [
      {
        left: 3 * minute,
        actorName: "Maximilianaugustineverylongpreferredname R.",
        ...person(`Approving ${longName}'s application`, "Approve"),
      },
    ],
  },
  {
    section: "difficult",
    id: "long-summary",
    title: "Long summary",
    description: "Three named fields on an orientation.",
    view: "both",
    item: orientation,
    compare: true,
    changes: [
      {
        left: 3 * minute,
        summary:
          "Changing the start time, new volunteer spots and unregister deadline of the event on Thu, Nov 19",
        inlineSummary:
          "Changing the start time, new volunteer spots and unregister deadline",
        verb: "Change",
        targets: [{ target: "event:orientation", locked: true }],
      },
    ],
  },
  {
    section: "difficult",
    id: "long-message",
    title: "Long error",
    description: "A failure message several lines long.",
    view: "toast",
    changes: [
      {
        left: 0,
        status: "failed",
        message:
          "This change could not be made because the event was edited by another organizer while it waited, its registrations changed, and the email service did not respond. Try making it again.",
      },
    ],
  },
  {
    section: "difficult",
    id: "short-delay",
    title: "Event about to start",
    description: "A shorter delay than five minutes.",
    view: "toast",
    changes: [{ left: 40_000, delay: 45_000 }],
  },
  {
    section: "difficult",
    id: "stacked",
    title: "Two changes on one item",
    description: "Soonest first. Yours and another organizer's.",
    view: "inline",
    item: patrol,
    changes: [
      {
        id: "first",
        left: 90_000,
        summary: `Removing ${casey} from the event on Tue, Nov 17`,
        inlineSummary: `Removing ${casey}`,
        verb: "Remove",
        targets: [
          { target: "signup:casey", locked: true },
          { target: "event:patrol", locked: false },
        ],
      },
      {
        id: "second",
        left: 4 * minute,
        mine: false,
        actorName: "Robin A.",
        summary: "Changing the spots of the event on Tue, Nov 17",
        inlineSummary: "Changing the spots",
        verb: "Change",
      },
    ],
  },
  {
    section: "difficult",
    id: "many",
    title: "Many changes",
    description: "Five changes at once, all shown.",
    view: "toast",
    changes: [
      { id: "a", left: 4.5 * minute },
      {
        id: "b",
        left: 3 * minute,
        ...person(`Approving ${casey} for patrols`, "Approve"),
      },
      {
        id: "c",
        left: 2 * minute,
        mine: false,
        blocked: true,
        actorName: "Robin A.",
        summary: "Changing the spots of the event on Tue, Dec 1",
        verb: "Change",
      },
      {
        id: "d",
        left: 90_000,
        ...person("Rejecting Riley S.'s application", "Reject"),
      },
      {
        id: "e",
        left: 30_000,
        summary: "Cancelling the event on Tue, Dec 15",
      },
    ],
  },
  {
    section: "difficult",
    id: "phone",
    title: "Phone width",
    description: "Toasts span the screen.",
    view: "toast",
    narrow: true,
    changes: [
      { id: "a", left: 3 * minute },
      {
        id: "b",
        left: 2 * minute,
        mine: false,
        blocked: true,
        actorName: "Robin A.",
        ...person(`Approving ${casey} for patrols`, "Approve"),
      },
    ],
  },
];
