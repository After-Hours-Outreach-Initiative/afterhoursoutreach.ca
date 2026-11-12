import { PageScope } from "./page-lifecycle";
import { initVolunteerBrowser } from "./volunteer-browser";

/** Connect the controller to the actual directory DOM, including router swaps. */
class DirectoryController extends HTMLElement {
  private page?: PageScope;
  private controller?: AbortController;

  connectedCallback() {
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    const start = () => {
      if (this.page || !this.isConnected) return;
      this.page = new PageScope();
      initVolunteerBrowser(fetch, this.page);
    };
    document.addEventListener("astro:after-swap", start, { signal });
    document.addEventListener("astro:page-load", start, { signal });
    // During body adoption the URL still belongs to the outgoing screen.
    // Wait for after-swap before reading filters or updating history.
    if (!document.documentElement.hasAttribute("data-astro-transition"))
      start();
  }

  disconnectedCallback() {
    this.controller?.abort();
    this.page?.dispose();
    this.page = undefined;
  }
}

if (!customElements.get("directory-controller"))
  customElements.define("directory-controller", DirectoryController);
