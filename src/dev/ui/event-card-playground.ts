import { eventCardChannel } from "./event-card-fixtures";

if (import.meta.env.DEV) {
  const root = document.querySelector<HTMLElement>(
    "[data-ui-event-playground]",
  );
  const frames = Array.from(
    root?.querySelectorAll<HTMLIFrameElement>("[data-ui-event-frame]") ?? [],
  );
  const widthElement = root?.querySelector("[data-ui-event-width]");
  const width = widthElement instanceof HTMLSelectElement ? widthElement : null;
  const rosters = root?.querySelector<HTMLInputElement>(
    "[data-ui-event-rosters]",
  );
  const updateRosters = (frame: HTMLIFrameElement) => {
    frame.contentWindow?.postMessage(
      {
        channel: eventCardChannel,
        type: "rosters",
        open: Boolean(rosters?.checked),
      },
      location.origin,
    );
  };
  width?.addEventListener("change", () => {
    for (const frame of frames) {
      frame.width = width.value === "fit" ? "100%" : width.value;
      frame.style.width = width.value === "fit" ? "100%" : `${width.value}px`;
    }
  });
  rosters?.addEventListener("change", () => frames.forEach(updateRosters));
  frames.forEach((frame) =>
    frame.addEventListener("load", () => updateRosters(frame)),
  );
  root
    ?.querySelector("[data-ui-event-reset]")
    ?.addEventListener("click", () => {
      if (width) width.value = "fit";
      if (rosters) rosters.checked = false;
      for (const frame of frames) {
        frame.width = "100%";
        frame.style.removeProperty("width");
        const url = new URL(frame.src);
        url.searchParams.delete("registered");
        url.searchParams.delete("roster");
        frame.src = url.href;
      }
    });
  window.addEventListener("message", (event) => {
    if (
      event.origin !== location.origin ||
      event.data?.channel !== eventCardChannel ||
      event.data.type !== "height"
    )
      return;
    const frame = frames.find(
      (candidate) => candidate.contentWindow === event.source,
    );
    if (frame && Number.isFinite(event.data.height)) {
      frame.height = String(
        Math.max(160, Math.min(2000, Math.ceil(event.data.height))),
      );
    }
  });
}
