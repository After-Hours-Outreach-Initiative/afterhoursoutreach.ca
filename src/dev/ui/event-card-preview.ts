import { eventCardChannel } from "./event-card-fixtures";
import { confirmEventUnregistration } from "../../scripts/event-unregistration";
import { initCompactPersonNames } from "../../scripts/compact-person-name";

if (import.meta.env.DEV) {
  initCompactPersonNames();
  const root = document.querySelector<HTMLElement>("[data-ui-event-preview]");
  const roster = root?.querySelector<HTMLDetailsElement>("details");
  if (roster)
    roster.open = new URLSearchParams(location.search).get("roster") === "open";

  // Use the real forms but navigate only within the fictional preview. Its CSP
  // also blocks native form submissions if scripts fail to load.
  document.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    if (
      !(form instanceof HTMLFormElement) ||
      !form.matches("[data-live-signup]") ||
      form.dataset.submitting
    )
      return;
    const action = new FormData(form).get("action");
    const button = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    form.dataset.submitting = "true";
    if (button) button.disabled = true;
    try {
      if (action === "cancel") {
        // A wide preview may be scrolled to its right-hand action. Reveal the
        // confirmation controls inside the iframe before opening the modal.
        window.frameElement?.scrollIntoView({
          block: "center",
          inline: "start",
        });
        if (!(await confirmEventUnregistration(form))) return;
      }
      const url = new URL(location.href);
      url.searchParams.set("registered", action === "join" ? "1" : "0");
      url.searchParams.set("roster", roster?.open ? "open" : "closed");
      location.replace(url.href);
    } finally {
      delete form.dataset.submitting;
      if (button) {
        button.disabled = false;
        button.focus({ preventScroll: true });
      }
    }
  });
  window.addEventListener("message", (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== parent ||
      event.data?.channel !== eventCardChannel
    )
      return;
    if (event.data.type === "rosters" && roster)
      roster.open = Boolean(event.data.open);
  });
  if (root && parent !== window) {
    new ResizeObserver(() => {
      parent.postMessage(
        {
          channel: eventCardChannel,
          type: "height",
          height: root.getBoundingClientRect().height,
        },
        location.origin,
      );
    }).observe(root);
  }
}
