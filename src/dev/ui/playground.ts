import {
  getDiscordScenario,
  longFakeUsername,
  playgroundChannel,
  previewQuery,
  readPreviewOptions,
} from "./fixtures";

function initializePlayground() {
  const controls =
    document.querySelector<HTMLFormElement>("[data-ui-controls]");
  const frame = document.querySelector<HTMLIFrameElement>(
    "[data-ui-live-preview]",
  );
  if (!controls || !frame) return;
  const form = controls;
  const preview = frame;
  const status = document.querySelector<HTMLElement>(
    "[data-ui-simulation-status]",
  );
  const description = document.querySelector<HTMLElement>(
    "[data-ui-scenario-description]",
  );
  const state = document.querySelector<HTMLElement>("[data-ui-state]");
  const openLink = document.querySelector<HTMLAnchorElement>(
    "[data-ui-open-preview]",
  );
  let options = readPreviewOptions(new URLSearchParams(window.location.search));

  function fromControls() {
    const params = new URLSearchParams();
    new FormData(form).forEach((value, name) => {
      if (typeof value === "string") params.append(name, value);
    });
    return readPreviewOptions(params);
  }

  function configurePreview() {
    preview.contentWindow?.postMessage(
      {
        channel: playgroundChannel,
        type: "configure",
        query: previewQuery(options).toString(),
      },
      window.location.origin,
    );
  }

  function update(reload = false) {
    options = fromControls();
    const query = previewQuery(options);
    const url = new URL(window.location.href);
    url.search = query.toString();
    window.history.replaceState(null, "", url);
    if (openLink) openLink.href = `/dev/ui/discord?${query}`;
    preview.width = options.size === "narrow" ? "360" : "1024";
    if (description)
      description.textContent = getDiscordScenario(
        options.scenario,
      ).description;
    if (reload) {
      preview.src = `/dev/ui/discord?${query}`;
      if (status)
        status.textContent = `Loading: ${getDiscordScenario(options.scenario).label}`;
    } else {
      configurePreview();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    update(true);
  });
  form.addEventListener("change", (event) => {
    if (!(
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    ))
      return;
    const name = event.target.name;
    if (name === "scenario") {
      const eligible = form.querySelector<HTMLInputElement>(
        'input[type="checkbox"][name="eligible"]',
      );
      if (eligible)
        eligible.checked =
          getDiscordScenario(event.target.value).eligible !== false;
    }
    update(["scenario", "eligible", "required"].includes(name));
  });
  form
    .querySelector<HTMLInputElement>('[name="username"]')
    ?.addEventListener("input", () => update());
  document
    .querySelector("[data-ui-long-name]")
    ?.addEventListener("click", () => {
      const username =
        form.querySelector<HTMLInputElement>('[name="username"]');
      if (username) username.value = longFakeUsername;
      update();
    });
  document.querySelector("[data-ui-reset]")?.addEventListener("click", () => {
    // Restore the selected fixture in a fresh frame without losing its controls.
    update(true);
  });
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.origin !== window.location.origin ||
      event.data?.channel !== playgroundChannel ||
      event.data?.type !== "state"
    )
      return;
    const sourceFrame = [
      ...document.querySelectorAll<HTMLIFrameElement>("iframe"),
    ].find((candidate) => candidate.contentWindow === event.source);
    if (!sourceFrame) return;
    if (
      typeof event.data.height === "number" &&
      Number.isFinite(event.data.height)
    ) {
      const height = Math.min(
        1400,
        Math.max(sourceFrame === preview ? 360 : 280, event.data.height),
      );
      if (sourceFrame.height !== String(height))
        sourceFrame.height = String(height);
    }
    if (sourceFrame !== preview) return;
    if (typeof event.data.phase === "string" && status) {
      status.textContent = `Simulation: ${event.data.phase.replaceAll("-", " ")}`;
    }
    if (state)
      state.textContent = JSON.stringify(
        { phase: event.data.phase, ...event.data.status },
        null,
        2,
      );
  });

  // Frames can finish before this module starts. Subscribe first, then request
  // a fresh report now as well as after any pending or subsequent navigation.
  preview.addEventListener("load", configurePreview);
  configurePreview();
  document
    .querySelectorAll<HTMLIFrameElement>(".ui-gallery-card iframe")
    .forEach((galleryFrame) => {
      const requestState = () =>
        galleryFrame.contentWindow?.postMessage(
          { channel: playgroundChannel, type: "request-state" },
          window.location.origin,
        );
      galleryFrame.addEventListener("load", requestState);
      requestState();
    });
}

if (import.meta.env.DEV) initializePlayground();
