const selector = "[data-native-date]";

export function syncNativePickerInput(input: HTMLInputElement) {
  input.toggleAttribute("data-empty", !input.value);
}

function sync(root: Document | HTMLElement) {
  for (const input of root.querySelectorAll<HTMLInputElement>(selector))
    syncNativePickerInput(input);
}

export function initNativePickerInputs() {
  for (const type of ["input", "change"])
    document.addEventListener(type, (event) => {
      if (
        event.target instanceof HTMLInputElement &&
        event.target.matches(selector)
      )
        syncNativePickerInput(event.target);
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
