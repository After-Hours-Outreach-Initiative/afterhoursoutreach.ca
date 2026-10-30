import { initVolunteerBrowser } from "../../scripts/volunteer-browser";
import { readTableOptions, tableChannel, tableKind } from "./table-fixtures";

if (import.meta.env.DEV) {
  const kind = tableKind(location.pathname);
  const options = readTableOptions(kind, new URLSearchParams(location.search));
  const report = (message: string) => {
    if (parent !== window)
      parent.postMessage(
        { channel: tableChannel, type: "request", message },
        location.origin,
      );
  };
  // Inject only the read-only fixture transport; keep the real browser controller.
  // No global fetch patch or production API calls are needed.
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (
      url.origin !== location.origin ||
      url.pathname !== `/dev/ui/${kind}/preview` ||
      (init?.method ?? "GET") !== "GET"
    )
      throw new Error("Only fictional table previews can be loaded here.");
    const signal = init?.signal;
    report(
      options.outcome === "pending"
        ? "Loading paused. Reset the preview or choose a successful response to continue."
        : "Loading fictional results…",
    );
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer =
        options.outcome === "pending"
          ? undefined
          : window.setTimeout(() => {
              signal?.removeEventListener("abort", abort);
              resolve();
            }, options.latency);
      signal?.addEventListener("abort", abort, { once: true });
    });
    if (options.outcome === "failure") {
      report(
        "Simulated failed update. Existing rows are preserved; choose a successful response to retry.",
      );
      return new Response(null, { status: 503 });
    }
    const response = await fetch(url, { ...init, credentials: "omit" });
    report(
      "Fictional results updated. Search, filters, and sort order stay in this preview.",
    );
    return response;
  };
  initVolunteerBrowser(fetchFixture);
}
