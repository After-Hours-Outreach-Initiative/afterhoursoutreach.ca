import { focusAfterUpdate } from "./focus";

/** Refresh only when a milestone changes, leaving unrelated expanded steps alone. */
export function syncApplicationProgress(page: Document) {
  const tracker = document.querySelector<HTMLElement>(
    "[data-application-tracker]",
  );
  if (!tracker) return;
  const next = page.querySelector<HTMLElement>("[data-application-tracker]");
  const focused = document.activeElement;
  const restoreFocus = tracker.contains(focused);
  if (!next) {
    tracker.remove();
    if (restoreFocus)
      focusAfterUpdate(document.querySelector("#events-heading"));
    document.dispatchEvent(new Event("account-content-updated"));
    return;
  }
  if (tracker.dataset.progressVersion === next.dataset.progressVersion) return;
  const previous = new Map(
    (JSON.parse(tracker.dataset.progressVersion!) as { key: string }[]).map(
      (step) => [step.key, JSON.stringify(step)],
    ),
  );
  const focusedStep = focused?.closest<HTMLElement>(
    "[data-application-progress-step]",
  )?.dataset.applicationProgressStep;
  for (const milestone of JSON.parse(next.dataset.progressVersion!) as {
    key: string;
  }[]) {
    const selector = `[data-application-progress-step="${CSS.escape(milestone.key)}"]`;
    const step = tracker.querySelector<HTMLDetailsElement>(selector)!;
    const updated = next.querySelector<HTMLDetailsElement>(selector)!;
    const current = updated.parentElement!.getAttribute("aria-current");
    if (current) step.parentElement!.setAttribute("aria-current", current);
    else step.parentElement!.removeAttribute("aria-current");
    if (previous.get(milestone.key) === JSON.stringify(milestone)) {
      if (step.dataset.state !== updated.dataset.state)
        step
          .querySelector("summary")!
          .replaceWith(
            document.importNode(updated.querySelector("summary")!, true),
          );
      // A new current step opens after completion, but an unrelated milestone
      // must not reset expanded snapshots, course drafts, or their focus.
      if (
        step.dataset.state !== "current" &&
        updated.dataset.state === "current"
      )
        step.open = true;
      step.dataset.state = updated.dataset.state;
    } else step.replaceWith(document.importNode(updated, true));
  }
  tracker.dataset.progressVersion = next.dataset.progressVersion;
  if (restoreFocus && !focused?.isConnected)
    focusAfterUpdate(
      (focused?.matches("summary") && focusedStep
        ? tracker.querySelector<HTMLElement>(
            `[data-application-progress-step="${CSS.escape(focusedStep)}"] > summary`,
          )
        : tracker.querySelector<HTMLElement>(
            '[aria-current="step"] summary',
          )) ?? tracker.querySelector("summary"),
    );
  document.dispatchEvent(new Event("account-content-updated"));
}
