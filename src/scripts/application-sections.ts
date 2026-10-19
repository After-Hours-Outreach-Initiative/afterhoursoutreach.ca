import { initPageContents } from "./page-contents";

export function initApplicationSections(element: HTMLFormElement) {
  if (!element.hasAttribute("data-application")) return;
  const flow = element.closest<HTMLElement>("[data-application-flow]");
  const content = element.querySelector<HTMLElement>(
    "[data-application-questions]",
  );
  if (!flow || !content) return;
  initPageContents(flow, { content, topId: "application-overview" });

  const links = [
    ...flow.querySelectorAll<HTMLAnchorElement>(
      "[data-application-progress-link]",
    ),
  ];
  const counts = flow.querySelectorAll<HTMLElement>(
    "[data-application-progress-count]",
  );
  const update = () => {
    const sections = new Map<string, boolean>();
    for (const link of links) {
      const section = document.getElementById(link.hash.slice(1));
      if (!section) continue;
      const fields = section.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >("input, textarea");
      // Reading validity never fires `invalid` or opens/focuses a section.
      // Conditional controls opt out through the form's existing validators;
      // collapsed sections still count. Sections with no requirements are done.
      const complete = [...fields].every(
        (field) =>
          !field.willValidate ||
          (field.validity.valid &&
            (!field.required || Boolean(field.value.trim()))),
      );
      // Only completable entries carry progress links; deduplicate responsive copies.
      sections.set(section.id, complete);
      link.dataset.complete = String(complete);
      const status = link.parentElement?.querySelector<HTMLElement>(
        "[data-application-completion-status]",
      );
      const message = complete ? "Complete" : "Incomplete";
      if (status && status.textContent?.trim() !== message)
        status.textContent = message;
    }
    const completed = [...sections.values()].filter(Boolean).length;
    const message = `${completed}/${sections.size} complete`;
    for (const count of counts)
      if (count.textContent?.trim() !== message) count.textContent = message;
  };
  element.addEventListener("input", update);
  element.addEventListener("change", update);
  element.addEventListener("application-draft-restored", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}
