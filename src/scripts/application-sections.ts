export function initApplicationSections(element: HTMLFormElement) {
  if (!element.hasAttribute("data-application")) return;
  const questions = element.querySelector<HTMLElement>(
    "[data-application-questions]",
  );
  const contents = element.querySelector<HTMLElement>(
    "[data-application-contents]",
  );
  const menu = contents?.querySelector<HTMLDetailsElement>(
    "[data-application-contents-menu]",
  );
  const toggle = menu?.querySelector<HTMLElement>("summary");
  const current = contents?.querySelector<HTMLElement>(
    "[data-application-current]",
  );
  if (!questions || !contents || !menu || !toggle || !current) return;
  const sections = [...contents.querySelectorAll<HTMLAnchorElement>("a")]
    .map((link) => ({
      link,
      target: document.getElementById(link.hash.slice(1)),
    }))
    .filter(
      (section): section is { link: HTMLAnchorElement; target: HTMLElement } =>
        Boolean(section.target && questions.contains(section.target)),
    );
  const header = document.querySelector<HTMLElement>("body > header");
  const navigation = document.querySelector<HTMLElement>(".volunteer-nav");
  let stickyHeight = 0;
  let contentsHeight = 0;
  let frame = 0;

  const measure = () => {
    const headerHeight = header?.getBoundingClientRect().height ?? 0;
    // Keep the existing navigation attached too, including when text wraps.
    navigation?.style.setProperty("top", `${headerHeight}px`);
    stickyHeight =
      headerHeight + (navigation?.getBoundingClientRect().height ?? 0);
    contentsHeight = contents.getBoundingClientRect().height;
    element.style.setProperty(
      "--application-sticky-offset",
      `${stickyHeight}px`,
    );
    element.style.setProperty(
      "--application-scroll-offset",
      `${stickyHeight + contentsHeight}px`,
    );
  };
  const activate = (link: HTMLAnchorElement) => {
    current.textContent = link.textContent?.trim() ?? "";
    for (const section of sections) {
      if (section.link === link)
        section.link.setAttribute("aria-current", "location");
      else section.link.removeAttribute("aria-current");
    }
  };
  const update = () => {
    frame = 0;
    if (questions.hidden) {
      menu.open = false;
      return;
    }
    // Use the reading edge, not intersection ratios: a tall section remains
    // current throughout its fields, and collapsed summaries still participate.
    const readingEdge = stickyHeight + contentsHeight + 16;
    let active = sections[0];
    for (const section of sections) {
      if (section.target.getBoundingClientRect().top > readingEdge + 1) break;
      active = section;
    }
    if (active && active.link.getAttribute("aria-current") !== "location")
      activate(active.link);
    const bounds = contents.getBoundingClientRect();
    const availableBottom = Math.min(
      window.innerHeight,
      questions.getBoundingClientRect().bottom,
    );
    element.style.setProperty(
      "--application-dropdown-space",
      `${Math.max(0, availableBottom - bounds.bottom - 16)}px`,
    );
    // The sticky bar is bounded by the questions, never the footer. Close its
    // absolute dropdown as the bar leaves that boundary as well.
    if (bounds.top < stickyHeight - 1) menu.open = false;
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
      parent && parent !== element;
      parent = parent.parentElement
    ) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
  };
  const visit = (hash: string) => {
    const section = sections.find(({ link }) => link.hash === hash);
    if (!section || questions.hidden) return;
    reveal(section.target);
    menu.open = false;
    measure();
    activate(section.link);
    const focusTarget =
      section.target instanceof HTMLDetailsElement
        ? section.target.querySelector<HTMLElement>("summary")
        : section.target;
    focusTarget?.focus({ preventScroll: true });
    section.target.scrollIntoView({ block: "start" });
    schedule();
  };
  for (const { link, target } of sections) {
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
  window.addEventListener("pageshow", refresh);
  window.addEventListener("hashchange", () => visit(location.hash));
  window.addEventListener("popstate", schedule);
  refresh();
  visit(location.hash);
}
