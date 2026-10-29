import { initPageContents } from "./page-contents";

const disposers = new WeakMap<HTMLElement, () => void>();

export function disposeVolunteerProfileContents(root: HTMLElement) {
  for (const flow of root.querySelectorAll<HTMLElement>(
    "[data-volunteer-profile]",
  )) {
    disposers.get(flow)?.();
    disposers.delete(flow);
  }
  if (root.matches("[data-volunteer-profile]")) {
    disposers.get(root)?.();
    disposers.delete(root);
  }
}

export function initVolunteerProfileContents(
  root: Document | HTMLElement = document,
  refreshing = false,
) {
  const flows = [
    ...root.querySelectorAll<HTMLElement>("[data-volunteer-profile]"),
  ];
  if (root instanceof HTMLElement && root.matches("[data-volunteer-profile]"))
    flows.push(root);
  for (const flow of flows) {
    if (disposers.has(flow)) continue;
    const dispose = initPageContents(flow, {
      initialHash: refreshing ? "" : undefined,
    });
    if (dispose) disposers.set(flow, dispose);
  }
}
