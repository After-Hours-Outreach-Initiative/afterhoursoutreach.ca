import { eventCardChannel } from "./event-card-fixtures";

if (import.meta.env.DEV) {
  const root = document.querySelector<HTMLElement>("[data-ui-event-preview]");
  const roster = root?.querySelector<HTMLDetailsElement>("details");
  if (roster)
    roster.open = new URLSearchParams(location.search).get("roster") === "open";

  // Use the real forms but navigate only within the fictional preview. Its CSP
  // also blocks native form submissions if scripts fail to load.
  document.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if (
      !(form instanceof HTMLFormElement) ||
      !form.matches("[data-live-signup]")
    )
      return;
    const url = new URL(location.href);
    url.searchParams.set(
      "registered",
      new FormData(form).get("action") === "join" ? "1" : "0",
    );
    url.searchParams.set("roster", roster?.open ? "open" : "closed");
    location.replace(url.href);
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
