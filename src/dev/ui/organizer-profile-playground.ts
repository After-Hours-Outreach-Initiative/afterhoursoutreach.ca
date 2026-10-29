import {
  getProfileScenario,
  profileChannel,
  profilePreviewPath,
  profileQuery,
  profileWorkspacePath,
  readProfileOptions,
} from "./organizer-profile-fixtures";

function initializeProfilePlayground() {
  const form = document.querySelector<HTMLFormElement>(
    "[data-ui-profile-controls]",
  );
  const frame = document.querySelector<HTMLIFrameElement>(
    "[data-ui-profile-frame]",
  );
  if (!form || !frame) return;
  const controls = form;
  const preview = frame;
  const status = document.querySelector<HTMLElement>(
    "[data-ui-profile-status]",
  )!;
  const title = document.querySelector<HTMLElement>("[data-ui-profile-title]")!;
  const description = document.querySelector<HTMLElement>(
    "[data-ui-profile-description]",
  )!;
  const state = document.querySelector<HTMLElement>("[data-ui-profile-state]")!;
  const open = document.querySelector<HTMLAnchorElement>(
    "[data-ui-profile-open]",
  )!;
  const links = [
    ...document.querySelectorAll<HTMLAnchorElement>(
      "[data-ui-profile-scenario]",
    ),
  ];
  let options = readProfileOptions(new URLSearchParams(location.search));

  const configure = () =>
    preview.contentWindow?.postMessage(
      {
        channel: profileChannel,
        type: "configure",
        query: profileQuery(options).toString(),
      },
      location.origin,
    );
  function update(reload: boolean, push = false) {
    const params = new URLSearchParams();
    new FormData(controls).forEach((value, name) => {
      if (typeof value === "string") params.append(name, value);
    });
    options = readProfileOptions(params);
    const query = profileQuery(options);
    const url = `${profileWorkspacePath}?${query}`;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    const selected = getProfileScenario(options.scenario);
    title.textContent = selected.label;
    description.textContent = selected.description;
    for (const link of links) {
      const id = link.dataset.uiProfileScenario!;
      link.href = `${profileWorkspacePath}?${profileQuery({ ...options, scenario: id })}`;
      if (id === options.scenario) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    open.href = `${profilePreviewPath}?${query}`;
    preview.width = options.viewport === "fit" ? "100%" : options.viewport;
    preview.height = String(options.height);
    preview.classList.toggle(
      "ui-profile-frame-fit",
      options.viewport === "fit",
    );
    if (reload) {
      status.textContent = `Loading: ${selected.label}`;
      preview.inert = true;
      preview.setAttribute("aria-busy", "true");
      preview.src = open.href;
    } else configure();
  }
  for (const link of links)
    link.addEventListener("click", (event) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      controls.querySelector<HTMLInputElement>('[name="scenario"]')!.value =
        link.dataset.uiProfileScenario!;
      update(true, true);
    });
  controls.addEventListener("submit", (event) => {
    event.preventDefault();
    update(true);
  });
  controls.addEventListener("change", (event) => {
    if (!(
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    ))
      return;
    update(["surface", "content", "phase"].includes(event.target.name));
  });
  document
    .querySelector("[data-ui-profile-reset]")
    ?.addEventListener("click", () => update(true));
  document
    .querySelector("[data-ui-profile-copy]")
    ?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        status.textContent = "Scenario link copied.";
      } catch {
        status.textContent = "Copy the scenario URL from the address bar.";
      }
    });
  document
    .querySelector<HTMLInputElement>("[data-ui-state-search]")
    ?.addEventListener("input", (event) => {
      const query = (event.target as HTMLInputElement).value
        .trim()
        .toLowerCase();
      let visible = 0;
      for (const link of links) {
        link.hidden = !link.textContent?.toLowerCase().includes(query);
        if (!link.hidden) visible++;
      }
      for (const group of document.querySelectorAll<HTMLElement>(
        "[data-ui-state-group]",
      ))
        group.hidden = !group.querySelector(
          "[data-ui-profile-scenario]:not([hidden])",
        );
      document.querySelector<HTMLElement>("[data-ui-state-empty]")!.hidden =
        visible > 0;
    });
  window.addEventListener("popstate", () => {
    options = readProfileOptions(new URLSearchParams(location.search));
    for (const [name, value] of Object.entries(options)) {
      const field = controls.elements.namedItem(name);
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement
      )
        field.value = String(value);
    }
    update(true);
  });
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.origin !== location.origin ||
      event.source !== preview.contentWindow ||
      event.data?.channel !== profileChannel ||
      event.data.type !== "state" ||
      event.data.query !== profileQuery(options).toString()
    )
      return;
    status.textContent = `Simulation: ${String(event.data.phase).replaceAll("-", " ")}${event.data.modified ? " · fictional changes only" : ""}`;
    state.textContent = JSON.stringify(event.data.state, null, 2);
  });
  preview.addEventListener("load", () => {
    preview.inert = false;
    preview.removeAttribute("aria-busy");
    configure();
  });
  configure();
}

if (import.meta.env.DEV) initializeProfilePlayground();
