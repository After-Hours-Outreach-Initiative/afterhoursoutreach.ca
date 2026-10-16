import { initPageContents } from "./page-contents";

export function initApplicationSections(element: HTMLFormElement) {
  if (!element.hasAttribute("data-application")) return;
  const flow = element.closest<HTMLElement>("[data-application-flow]");
  const content = element.querySelector<HTMLElement>(
    "[data-application-questions]",
  );
  if (flow && content)
    initPageContents(flow, { content, topId: "application-overview" });
}
