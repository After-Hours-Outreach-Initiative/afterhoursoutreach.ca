const header = document.querySelector<HTMLElement>(".site-header")!;
const menus = [
  ...header.querySelectorAll<HTMLDetailsElement>("[data-header-menu]"),
];
const mobileNav = header.querySelector<HTMLDetailsElement>(".mobile-nav")!;
const desktop = matchMedia("(min-width: 64rem)");

// Wrapped branding can make the header taller than its responsive minimum.
// Keep the panel's height allowance separate so the header can shrink again.
// Share the measurement with sticky content and event anchor offsets as well.
new ResizeObserver(() => {
  document.documentElement.style.setProperty(
    "--site-header-rendered-height",
    `${header.getBoundingClientRect().height}px`,
  );
}).observe(header);

function closeMenus(except?: HTMLDetailsElement) {
  for (const menu of menus)
    if (menu !== except && (!except || !menu.contains(except)))
      menu.open = false;
}

closeMenus();

for (const menu of menus) {
  menu.addEventListener("toggle", () => {
    const toggle = menu.querySelector("summary")!;
    toggle.setAttribute("aria-expanded", String(menu.open));
    if (menu === mobileNav)
      toggle.setAttribute(
        "aria-label",
        menu.open ? "Close navigation" : "Open navigation",
      );
    if (menu.open) {
      closeMenus(menu);
      if (menu === mobileNav)
        for (const child of menu.querySelectorAll<HTMLDetailsElement>(
          "[data-header-menu]",
        ))
          child.open = true;
    } else
      for (const child of menus)
        if (menu.contains(child) && child !== menu) child.open = false;
  });
  menu.addEventListener("focusout", (event) => {
    if (
      event.relatedTarget instanceof Node &&
      !menu.contains(event.relatedTarget)
    )
      menu.open = false;
  });
  if (menu.hasAttribute("data-header-hover-menu")) {
    let openedOnHover = false;
    menu.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" || !desktop.matches || menu.open)
        return;
      openedOnHover = true;
      menu.open = true;
    });
    // Native click/keyboard toggling takes ownership from hover.
    menu.querySelector("summary")!.addEventListener("click", () => {
      openedOnHover = false;
    });
    menu.addEventListener("pointerleave", () => {
      if (openedOnHover && !menu.contains(document.activeElement))
        menu.open = false;
      openedOnHover = false;
    });
  }
}

document.addEventListener("click", (event) => {
  for (const menu of menus)
    if (event.target instanceof Node && !menu.contains(event.target))
      menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const open = [...menus].reverse().find((menu) => menu.open);
  if (!open) return;
  open.open = false;
  open.querySelector<HTMLElement>("summary")?.focus();
});
// Keep the mobile menu visible until navigation replaces the current page.
header.querySelectorAll(".header-dropdown a").forEach((link) => {
  link.addEventListener("click", () => closeMenus());
});
desktop.addEventListener("change", () => closeMenus());

// Account pages own this action so they can synchronize unsaved application
// drafts first. Other pages load the auth client only when signing out.
if (!document.querySelector("[data-account-layout]")) {
  for (const form of header.querySelectorAll<HTMLFormElement>(
    "[data-sign-out]",
  ))
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const button = form.querySelector<HTMLButtonElement>("button")!;
      if (button.disabled) return;
      const message = form.querySelector<HTMLElement>("[data-form-message]")!;
      button.disabled = true;
      message.hidden = true;
      try {
        const { signOut } = await import("./sign-out");
        await signOut();
        location.assign("/volunteer/sign-in");
      } catch {
        message.textContent = "Could not sign out. Please try again.";
        message.hidden = false;
        button.disabled = false;
      }
    });
}

export {};
