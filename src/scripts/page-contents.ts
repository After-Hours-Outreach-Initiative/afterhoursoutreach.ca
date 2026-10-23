export function initPageContents(
  flow: HTMLElement,
  {
    content = flow,
    contents = flow.querySelector<HTMLElement>("[data-page-contents]"),
    topId,
  }: {
    content?: HTMLElement;
    contents?: HTMLElement | null;
    topId?: string;
  } = {},
) {
  const menu = contents?.querySelector<HTMLDetailsElement>(
    "[data-contents-menu]",
  );
  const toggle = menu?.querySelector<HTMLElement>("summary");
  const current = contents?.querySelector<HTMLElement>(
    "[data-contents-current]",
  );
  if (!contents || !menu || !toggle || !current) return;
  const bar =
    contents.querySelector<HTMLElement>("[data-contents-bar]") ?? menu;
  const review = contents.hasAttribute("data-application-review-contents");
  const application =
    contents.hasAttribute("data-application-contents") || review;
  const idleHeading = contents.dataset.contentsIdleHeading;
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
  const actions = application
    ? sections.find(({ target }) =>
        target?.hasAttribute("data-contents-actions"),
      )
    : undefined;
  const header = document.querySelector<HTMLElement>("body > header");
  let stickyHeight = 0;
  let barHeight = 0;
  let readingGap = 0;
  let frame = 0;

  const measure = () => {
    // Only the visible step's navigation may set the shared scroll offsets.
    if (contents.hidden) {
      menu.open = false;
      return;
    }
    // A preview banner can initially shift the sticky header down.
    const headerPosition = header && getComputedStyle(header).position;
    stickyHeight =
      headerPosition === "sticky" || headerPosition === "fixed"
        ? Math.max(0, header?.getBoundingClientRect().bottom ?? 0)
        : 0;
    // Include the compact band's padding in the reading edge, not its dropdown.
    barHeight = menu.getBoundingClientRect().height
      ? bar.getBoundingClientRect().height
      : 0;
    if (!barHeight) menu.open = false;
    // Match the shared 1rem scroll-margin gap without rescaling measured pixels.
    readingGap = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    flow.style.setProperty("--contents-sticky-offset", `${stickyHeight}px`);
    flow.style.setProperty("--contents-bar-height", `${barHeight}px`);
    flow.style.setProperty(
      "--contents-scroll-offset",
      `${stickyHeight + barHeight}px`,
    );
    contents.toggleAttribute(
      "data-contents-stuck",
      barHeight > 0 &&
        getComputedStyle(contents).position === "sticky" &&
        Math.abs(contents.getBoundingClientRect().top - stickyHeight) < 1,
    );
  };
  const activate = (active: (typeof sections)[number]) => {
    const overview = application && active.hash === `#${topId}`;
    const heading =
      idleHeading && !contents.hasAttribute("data-contents-stuck")
        ? idleHeading
        : overview
          ? "Sections"
          : (active.links[0].textContent?.trim() ?? "");
    if (current.textContent !== heading) current.textContent = heading;
    if (active.links[0].getAttribute("aria-current") === "location") return;
    for (const section of sections)
      for (const link of section.links) {
        if (section === active) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
  };
  // Count the final actions as current when they reach the lower reading edge,
  // even when the document ends before they can reach the headings' top edge.
  const actionsReadingEdge = (height: number) =>
    Math.max(
      stickyHeight + barHeight + readingGap + height / 2,
      Math.min(
        window.innerHeight * 0.75,
        window.innerHeight - readingGap - height / 2,
      ),
    );
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
    const readingEdge = stickyHeight + barHeight + readingGap;
    let active = sections[0];
    for (const section of sections) {
      if (section === actions) continue;
      const target = section.target;
      if (!target || !target.getClientRects().length) continue;
      if (target.getBoundingClientRect().top > readingEdge + 1) break;
      active = section;
    }
    // The final action entry uses its own reading edge, not the headings' top
    // edge, so a jump there stays current and scrolling back naturally leaves it.
    const actionBounds = actions?.target?.getBoundingClientRect();
    if (
      actions &&
      actionBounds?.height &&
      actionBounds.top + actionBounds.height / 2 <=
        actionsReadingEdge(actionBounds.height) + 1
    )
      active = actions;
    // The compact label can change at the sticky edge within the same section.
    if (active) activate(active);
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
  const revealSection = (hash: string) => {
    const section = sections.find((section) => section.hash === hash);
    const target = section?.target;
    if (!section || !target || content.hidden || contents.hidden) return;
    reveal(target);
    menu.open = false;
    // Prepare hidden content and CSS scroll margins before the native jump.
    // The browser owns fragment scrolling, focus and history restoration.
    refresh();
  };
  // In-content reminders must reveal the same collapsed parents as navigation
  // links, including repeated jumps to the current hash and refreshed markup.
  flow.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    if (
      link &&
      link.origin === location.origin &&
      link.pathname === location.pathname &&
      link.search === location.search
    )
      revealSection(link.hash);
  });
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
    bar,
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
  window.addEventListener("pageshow", refresh);
  window.addEventListener("hashchange", () => revealSection(location.hash));
  window.addEventListener("popstate", schedule);
  refresh();
  revealSection(location.hash);
}
