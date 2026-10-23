import { actionFragment } from "./action-page";
import { focusAfterUpdate } from "./focus";

/** Refresh only when a milestone changes, leaving unrelated expanded steps alone. */
export function syncApplicationProgress(page: Document) {
  const tracker = document.querySelector<HTMLElement>(
    "[data-application-tracker]",
  );
  if (!tracker) return;
  const next = page.querySelector<HTMLElement>("[data-application-tracker]");
  const restoreFocus = tracker.contains(document.activeElement);
  if (!next) {
    tracker.remove();
    if (restoreFocus)
      focusAfterUpdate(document.querySelector("#events-heading"));
    document.dispatchEvent(new Event("account-content-updated"));
    return;
  }
  if (tracker.dataset.progressVersion === next.dataset.progressVersion) return;
  const replacement = actionFragment(page, "[data-application-tracker]");
  tracker.replaceWith(replacement);
  if (restoreFocus)
    focusAfterUpdate(
      replacement.querySelector('[aria-current="step"] summary') ??
        replacement.querySelector("summary"),
    );
  document.dispatchEvent(new Event("account-content-updated"));
}
