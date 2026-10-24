import { initPageContents } from "./page-contents";

export function initApplicationSections(element: HTMLFormElement) {
  if (!element.hasAttribute("data-application")) return;
  const flow = element.closest<HTMLElement>("[data-application-flow]");
  const content = element.querySelector<HTMLElement>(
    "[data-application-questions]",
  );
  if (!flow || !content) return;
  initPageContents(flow, { content, topId: "application-overview" });
  const review = element.querySelector<HTMLElement>(
    "[data-application-review-step]",
  );
  const reviewContents = flow.querySelector<HTMLElement>(
    "[data-application-review-contents]",
  );
  if (review && reviewContents)
    initPageContents(flow, {
      content: review,
      contents: reviewContents,
      topId: "application-overview",
    });

  const links = [
    ...flow.querySelectorAll<HTMLAnchorElement>(
      "[data-application-progress-link]",
    ),
  ];
  const progress = flow.querySelectorAll<HTMLElement>(
    "[data-application-progress]",
  );
  const conflictWarnings = flow.querySelectorAll<HTMLElement>(
    "[data-application-conflict-warning]",
  );
  const update = () => {
    const sections = new Map<string, boolean>();
    const hasConflicts = Boolean(
      content.querySelector("[data-draft-conflicted]"),
    );
    for (const warning of conflictWarnings) warning.hidden = !hasConflicts;
    for (const link of links) {
      const section = document.getElementById(link.hash.slice(1));
      if (!section) continue;
      const container = section.closest(".volunteer-application-section");
      const fields = container?.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >("input, textarea");
      if (!fields) continue;
      // Reading validity never fires `invalid` or focuses a section.
      // Conditional controls opt out through the form's existing validators;
      // sections with no requirements are done.
      const conflicted = Boolean(
        container?.querySelector("[data-draft-conflicted]"),
      );
      const complete =
        !conflicted &&
        [...fields].every(
          (field) =>
            !field.willValidate ||
            (field.validity.valid &&
              (!field.required || Boolean(field.value.trim()))),
        );
      // Only completable entries carry progress links; deduplicate responsive copies.
      sections.set(section.id, complete);
      link.dataset.complete = String(complete);
      link.dataset.conflicted = String(conflicted);
      const status = link.parentElement?.querySelector<HTMLElement>(
        "[data-application-completion-status]",
      );
      const message = conflicted
        ? "Conflicting answers"
        : complete
          ? "Complete"
          : "Incomplete";
      if (status && status.textContent?.trim() !== message)
        status.textContent = message;
    }
    const completed = [...sections.values()].filter(Boolean).length;
    for (const indicator of progress) {
      indicator.hidden = hasConflicts;
      indicator.setAttribute("aria-valuemax", String(sections.size));
      indicator.setAttribute("aria-valuenow", String(completed));
      indicator.setAttribute(
        "aria-valuetext",
        `${completed} of ${sections.size} sections complete`,
      );
      indicator.dataset.complete = String(completed === sections.size);
      indicator
        .querySelector("[data-application-progress-value]")
        ?.setAttribute(
          "stroke-dashoffset",
          String(sections.size ? 100 - (completed / sections.size) * 100 : 100),
        );
    }
  };
  element.addEventListener("input", update);
  element.addEventListener("change", update);
  element.addEventListener("application-draft-restored", update);
  element.addEventListener("application-draft-conflicts-changed", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}
