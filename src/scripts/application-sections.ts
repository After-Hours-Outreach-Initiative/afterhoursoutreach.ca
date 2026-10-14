export function initApplicationSections(element: HTMLFormElement) {
  if (!element.hasAttribute("data-application")) return;
  const flow = element.closest<HTMLElement>("[data-application-flow]");
  const questions = element.querySelector<HTMLElement>(
    "[data-application-questions]",
  );
  const contents = flow?.querySelector<HTMLElement>(
    "[data-application-contents]",
  );
  const menu = contents?.querySelector<HTMLDetailsElement>(
    "[data-application-contents-menu]",
  );
  const toggle = menu?.querySelector<HTMLElement>("summary");
  const current = contents?.querySelector<HTMLElement>(
    "[data-application-current]",
  );
  if (!flow || !questions || !contents || !menu || !toggle || !current) return;
  const links = [...contents.querySelectorAll<HTMLAnchorElement>("a")];
  // Both responsive lists share each section, so targets are measured and
  // observed once while all of their links stay in sync.
  const sections = [
    ...flow.querySelectorAll<HTMLElement>("[data-application-section]"),
  ]
    .map((target) => ({
      target,
      links: links.filter((link) => link.hash === `#${target.id}`),
    }))
    .filter((section) => section.links.length);
  const header = document.querySelector<HTMLElement>("body > header");
  const navigation = document.querySelector<HTMLElement>(".volunteer-nav");
  let stickyHeight = 0;
  let barHeight = 0;
  let frame = 0;

  const measure = () => {
    // Measure the actual stack bottom: a preview banner can initially shift the
    // header down, and the account navigation can wrap onto another line.
    const headerBottom = Math.max(
      0,
      header?.getBoundingClientRect().bottom ?? 0,
    );
    navigation?.style.setProperty("top", `${headerBottom}px`);
    stickyHeight =
      headerBottom + (navigation?.getBoundingClientRect().height ?? 0);
    // CSS hides the mobile disclosure at the sidebar breakpoint. Its absolute
    // dropdown never adds height, and the desktop sidebar must not affect jumps.
    barHeight = menu.getBoundingClientRect().height;
    if (!barHeight) menu.open = false;
    if (!barHeight && !contents.hidden) {
      // The fixed sidebar still aligns with the reserved second grid track.
      // Read the track, never the nav's possibly stale width after a breakpoint.
      const sidebarWidth = Number.parseFloat(
        getComputedStyle(flow).gridTemplateColumns.split(" ")[1] ?? "",
      );
      if (sidebarWidth > 0) {
        flow.style.setProperty(
          "--application-sidebar-start",
          `${flow.getBoundingClientRect().right - sidebarWidth}px`,
        );
        flow.style.setProperty(
          "--application-sidebar-width",
          `${sidebarWidth}px`,
        );
      }
    }
    flow.style.setProperty("--application-sticky-offset", `${stickyHeight}px`);
    flow.style.setProperty("--application-bar-height", `${barHeight}px`);
    flow.style.setProperty(
      "--application-scroll-offset",
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
    if (questions.hidden) {
      menu.open = false;
      return;
    }
    // Use the reading edge, not intersection ratios: a tall section remains
    // current throughout its fields, and collapsed summaries still participate.
    const readingEdge = stickyHeight + barHeight + 16;
    let active = sections[0];
    for (const section of sections) {
      if (section.target.getBoundingClientRect().top > readingEdge + 1) break;
      active = section;
    }
    if (active && active.links[0].getAttribute("aria-current") !== "location")
      activate(active);
    if (!barHeight) return;
    const bounds = menu.getBoundingClientRect();
    flow.style.setProperty(
      "--application-dropdown-space",
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
    const section = sections.find(({ target }) => `#${target.id}` === hash);
    if (!section || questions.hidden) return;
    reveal(section.target);
    menu.open = false;
    measure();
    activate(section);
    const focusTarget =
      section.target instanceof HTMLDetailsElement
        ? section.target.querySelector<HTMLElement>("summary")
        : section.target;
    focusTarget?.focus({ preventScroll: true });
    if (hash === "#application-overview")
      window.scrollTo({ top: 0, behavior: "instant" });
    else section.target.scrollIntoView({ block: "start" });
    schedule();
  };
  for (const { links, target } of sections) {
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
    target.addEventListener("toggle", refresh);
  }
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
  element.addEventListener(
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
    navigation,
    contents,
    menu,
    flow,
    questions,
    ...sections.map(({ target }) => target),
  ])
    if (target) resize.observe(target);
  const visibility = new MutationObserver(() => {
    if (questions.hidden) menu.open = false;
    refresh();
  });
  visibility.observe(questions, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", refresh);
  window.addEventListener("pageshow", (event) => {
    refresh();
    // Override the browser's initial fragment jump to the intro heading, while
    // leaving bfcache scroll restoration alone on subsequent page visits.
    if (!event.persisted && location.hash === "#application-overview")
      visit(location.hash);
  });
  window.addEventListener("hashchange", () => visit(location.hash));
  window.addEventListener("popstate", schedule);
  refresh();
  visit(location.hash);
}
