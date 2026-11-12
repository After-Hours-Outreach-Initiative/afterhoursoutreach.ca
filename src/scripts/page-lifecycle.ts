/** Resources belonging to one rendered screen, released before Astro swaps it. */
export class PageScope {
  private controller = new AbortController();
  private disposers: (() => void)[] = [];
  readonly signal = this.controller.signal;

  onDocument: typeof document.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (listener)
      document.addEventListener(type, listener, this.options(options));
  };
  onWindow: typeof window.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (listener)
      window.addEventListener(type, listener, this.options(options));
  };
  private options(options?: boolean | AddEventListenerOptions) {
    return {
      ...(typeof options === "boolean" ? { capture: options } : options),
      signal: this.signal,
    };
  }
  cleanup(dispose: (() => void) | undefined) {
    if (dispose) this.disposers.push(dispose);
  }
  dispose() {
    this.controller.abort();
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
  }
}

/** Also works on ordinary full-document pages, without ClientRouter. */
export function onPageLoad(initialize: (page: PageScope) => void) {
  let scope: PageScope | undefined;
  let body: HTMLElement | undefined;
  const start = () => {
    if (scope && body === document.body) return;
    scope?.dispose();
    body = document.body;
    scope = new PageScope();
    initialize(scope);
  };
  document.addEventListener("astro:before-swap", () => {
    scope?.dispose();
    scope = undefined;
  });
  document.addEventListener("astro:after-swap", start);
  document.addEventListener("astro:page-load", start);
  start();
}
