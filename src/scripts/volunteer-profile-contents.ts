import { initPageContents } from "./page-contents";

const disposers = new WeakMap<HTMLElement, () => void>();
const contentsFlowSelector =
  "[data-volunteer-profile], article[data-application-review]";

export function disposeVolunteerProfileContents(root: HTMLElement) {
  for (const flow of root.querySelectorAll<HTMLElement>(contentsFlowSelector)) {
    disposers.get(flow)?.();
    disposers.delete(flow);
  }
  if (root.matches(contentsFlowSelector)) {
    disposers.get(root)?.();
    disposers.delete(root);
  }
}

export function initVolunteerProfileContents(
  root: Document | HTMLElement = document,
  refreshing = false,
) {
  const flows = [...root.querySelectorAll<HTMLElement>(contentsFlowSelector)];
  if (root instanceof HTMLElement && root.matches(contentsFlowSelector))
    flows.push(root);
  for (const flow of flows) {
    if (disposers.has(flow)) continue;
    const dispose = initPageContents(flow, {
      initialHash: refreshing ? "" : undefined,
    });
    if (dispose) disposers.set(flow, dispose);
  }
}
