import {
  readTableOptions,
  tableChannel,
  tableKind,
  tablePreviewUrl,
  tableQuery,
  tableScenarios,
} from "./table-fixtures";

if (import.meta.env.DEV) {
  const form = document.querySelector<HTMLFormElement>(
    "[data-ui-table-controls]",
  );
  const frame = document.querySelector<HTMLIFrameElement>(
    "[data-ui-table-frame]",
  );
  const status = document.querySelector<HTMLElement>("[data-ui-table-status]");
  const open = document.querySelector<HTMLAnchorElement>(
    "[data-ui-table-open]",
  );
  const description = document.querySelector<HTMLElement>(
    "[data-ui-table-description]",
  );
  if (form && frame && status && open && description) {
    const kind = tableKind(location.pathname);
    const update = () => {
      const params = new URLSearchParams();
      new FormData(form).forEach((value, name) => {
        if (typeof value === "string") params.set(name, value);
      });
      const options = readTableOptions(kind, params);
      history.replaceState(null, "", `/dev/ui/${kind}?${tableQuery(options)}`);
      frame.inert = true;
      frame.setAttribute("aria-busy", "true");
      frame.src = tablePreviewUrl(kind, options);
      frame.width = options.width === "fit" ? "100%" : options.width;
      open.href = frame.src;
      description.textContent = tableScenarios(kind).find(
        ({ id }) => id === options.scenario,
      )!.description;
      status.textContent = "Loading fictional preview…";
    };
    frame.addEventListener("load", () => {
      frame.inert = false;
      frame.removeAttribute("aria-busy");
      status.textContent =
        "Preview ready. Search, filter, or sort to try the selected response.";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      update();
    });
    form.addEventListener("change", update);
    document
      .querySelector("[data-ui-table-reset]")
      ?.addEventListener("click", update);
    document
      .querySelector("[data-ui-table-copy]")
      ?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(location.href);
          status.textContent = "Scenario link copied.";
        } catch {
          status.textContent = "Copy the scenario URL from the address bar.";
        }
      });
    window.addEventListener("message", (event) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.contentWindow ||
        frame.inert ||
        event.data?.channel !== tableChannel
      )
        return;
      if (event.data.type === "request")
        status.textContent = String(event.data.message);
    });
  }
}
