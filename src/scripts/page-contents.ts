export function initPageContents(
  flow: HTMLElement,
  { content = flow, topId }: { content?: HTMLElement; topId?: string } = {},
) {
  const contents = flow.querySelector<HTMLElement>("[data-page-contents]");
  const menu = contents?.querySelector<HTMLDetailsElement>(
    "[data-contents-menu]",
  );
  const toggle = menu?.querySelector<HTMLElement>("summary");
  const current = contents?.querySelector<HTMLElement>(
    "[data-contents-current]",
  );
  if (!contents || !menu || !toggle || !current) return;
  const links = [...contents.querySelectorAll<HTMLAnchorElement>("a")];
  // Both responsive lists share each section, so targets are measured and
  // observed once while all of their links stay in sync.
  const sections = [...new Set(links.map((link) => link.hash))].map((hash) => ({
    hash,
    // Account settings can be replaced in place after authenticator changes.
    // Resolve by ID so jumps and scroll tracking never retain detached headings.
    get target() {
      const target = document.getElementById(hash.slice(1));
      return target && flow.contains(target) ? target : null;
    },
    links: links.filter((link) => link.hash === hash),
  }));
  const header = document.querySelector<HTMLElement>("body > header");
  let stickyHeight = 0;
  let barHeight = 0;
  let frame = 0;

  const measure = () => {
    // A preview banner can initially shift the sticky header down.
    stickyHeight = Math.max(0, header?.getBoundingClientRect().bottom ?? 0);
    // CSS hides the mobile disclosure at the sidebar breakpoint. Its absolute
    // dropdown never adds height, and the desktop sidebar must not affect jumps.
    barHeight = menu.getBoundingClientRect().height;
    if (!barHeight) menu.open = false;
    flow.style.setProperty("--contents-sticky-offset", `${stickyHeight}px`);
    flow.style.setProperty("--contents-bar-height", `${barHeight}px`);
    flow.style.setProperty(
      "--contents-scroll-offset",
      `${stickyHeight + barHeight}px`,
    );
  };
  const activate = (active: (typeof sections)[number]) => {
    current.textContent = active.links[0].textContent?.trim() ?? "";
    for (const section of sections)
      for (const link of section.links) {
        if (section === active) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
  };
  const update = () => {
    frame = 0;
    // Sticky headers can move without resizing as the preview banner scrolls.
    measure();
    if (content.hidden || contents.hidden) {
      menu.open = false;
      return;
    }
    // Use the reading edge, not intersection ratios: a tall section remains
    // current throughout its fields, and collapsed summaries still participate.
    const readingEdge = stickyHeight + barHeight + 16;
    let active = sections[0];
    for (const section of sections) {
      const target = section.target;
      if (!target || !target.getClientRects().length) continue;
      if (target.getBoundingClientRect().top > readingEdge + 1) break;
      active = section;
    }
    if (active && active.links[0].getAttribute("aria-current") !== "location")
      activate(active);
    if (!barHeight) return;
    const bounds = menu.getBoundingClientRect();
    flow.style.setProperty(
      "--contents-dropdown-space",
      `${Math.max(0, window.innerHeight - bounds.bottom - 16)}px`,
    );
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const refresh = () => {
    measure();
    schedule();
  };
  const reveal = (target: HTMLElement) => {
    for (
      let parent: HTMLElement | null = target;
      parent && parent !== flow;
      parent = parent.parentElement
    ) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
  };
  const visit = (hash: string) => {
    const section = sections.find((section) => section.hash === hash);
    const target = section?.target;
    if (!section || !target || content.hidden || contents.hidden) return;
    reveal(target);
    menu.open = false;
    measure();
    activate(section);
    const focusTarget =
      target instanceof HTMLDetailsElement
        ? target.querySelector<HTMLElement>("summary")
        : target;
    focusTarget?.focus({ preventScroll: true });
    if (hash === `#${topId}`) window.scrollTo({ top: 0, behavior: "instant" });
    else target.scrollIntoView({ block: "start", behavior: "instant" });
    schedule();
  };
  for (const { links } of sections) {
    for (const link of links)
      link.addEventListener("click", (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        // Preserve the review step's history state without a native anchor jump
        // racing the reveal/focus and measured scroll offset.
        if (location.hash !== link.hash)
          history.pushState(history.state, "", link.hash);
        visit(link.hash);
      });
  }
  flow.addEventListener("toggle", refresh, true);
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !contents.contains(event.target))
      menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    menu.open = false;
    toggle.focus({ preventScroll: true });
  });
  contents.addEventListener("focusout", (event) => {
    if (
      event.relatedTarget instanceof Node &&
      !contents.contains(event.relatedTarget)
    )
      menu.open = false;
  });
  // `invalid` does not bubble. Reveal all ancestors synchronously, before the
  // browser tries to focus its first invalid control (including nested fields).
  flow.addEventListener(
    "invalid",
    (event) => {
      if (event.target instanceof HTMLElement) reveal(event.target);
      menu.open = false;
      refresh();
    },
    true,
  );
  const resize = new ResizeObserver(refresh);
  for (const target of [
    header,
    contents,
    menu,
    flow,
    content,
    ...sections.map(({ target }) => target),
  ])
    if (target) resize.observe(target);
  const visibility = new MutationObserver(() => {
    if (content.hidden || contents.hidden) menu.open = false;
    refresh();
  });
  visibility.observe(flow, {
    attributes: true,
    attributeFilter: ["hidden"],
    childList: true,
    subtree: true,
  });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", refresh);
  window.addEventListener("pageshow", (event) => {
    refresh();
    // Override the browser's initial fragment jump to the intro heading, while
    // leaving bfcache scroll restoration alone on subsequent page visits.
    if (!event.persisted && location.hash === `#${topId}`) visit(location.hash);
  });
  window.addEventListener("hashchange", () => {
    // History traversal restores scroll after dispatching its events. Apply the
    // measured anchor jump afterwards so focus and the reading edge agree.
    requestAnimationFrame(() => visit(location.hash));
  });
  window.addEventListener("popstate", schedule);
  refresh();
  visit(location.hash);
}
