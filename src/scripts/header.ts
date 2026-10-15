const header = document.querySelector<HTMLElement>(".site-header")!;
const menus = [
  ...header.querySelectorAll<HTMLDetailsElement>("[data-header-menu]"),
];
const mobileNav = header.querySelector<HTMLDetailsElement>(".mobile-nav")!;

function closeMenus(except?: HTMLDetailsElement) {
  for (const menu of menus) if (menu !== except) menu.open = false;
}

for (const menu of menus) {
  menu.addEventListener("toggle", () => {
    const toggle = menu.querySelector("summary")!;
    toggle.setAttribute("aria-expanded", String(menu.open));
    if (menu === mobileNav)
      toggle.setAttribute(
        "aria-label",
        menu.open ? "Close navigation" : "Open navigation",
      );
    if (menu.open) closeMenus(menu);
  });
  menu.addEventListener("focusout", (event) => {
    if (
      event.relatedTarget instanceof Node &&
      !menu.contains(event.relatedTarget)
    )
      menu.open = false;
  });
}

document.addEventListener("click", (event) => {
  for (const menu of menus)
    if (event.target instanceof Node && !menu.contains(event.target))
      menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const open = menus.find((menu) => menu.open);
  if (!open) return;
  closeMenus();
  open.querySelector<HTMLElement>("summary")?.focus();
});
header.querySelectorAll(".mobile-nav a, .header-dropdown a").forEach((link) => {
  link.addEventListener("click", () => closeMenus());
});
matchMedia("(min-width: 1024px)").addEventListener("change", () =>
  closeMenus(),
);

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
