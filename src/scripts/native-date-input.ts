export function syncNativeDateInput(input: HTMLInputElement) {
  input.toggleAttribute("data-empty", !input.value);
}

function sync(root: Document | HTMLElement) {
  for (const input of root.querySelectorAll<HTMLInputElement>(
    "[data-native-date]",
  ))
    syncNativeDateInput(input);
}

export function initNativeDateInputs() {
  for (const type of ["input", "change"])
    document.addEventListener(type, (event) => {
      if (
        event.target instanceof HTMLInputElement &&
        event.target.hasAttribute("data-native-date")
      )
        syncNativeDateInput(event.target);
    });

  document.addEventListener("reset", (event) => {
    if (event.target instanceof HTMLFormElement) {
      const form = event.target;
      queueMicrotask(() => sync(form));
    }
  });
  window.addEventListener("pageshow", () => sync(document));
  sync(document);
}
