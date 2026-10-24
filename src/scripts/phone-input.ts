function formatNorthAmericanPhone(value: string): string | undefined {
  const match = value.trimStart().match(/^(\+?[\d().\s-]*?)(\s*[xX][\d\s]*)?$/);
  if (!match) return;
  const [, number, extension = ""] = match;
  let digits = number.replace(/\D/g, "");
  let prefix = "";
  if (number.startsWith("+")) {
    if (!number.startsWith("+1")) return;
    prefix = "+1";
    digits = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith("1")) {
    prefix = "1";
    digits = digits.slice(1);
  }
  if (digits.length > 10) return;
  const local = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]
    .filter(Boolean)
    .join("-");
  return [prefix, local].filter(Boolean).join("-") + extension;
}

/** Format North American numbers without truncating other accepted phone formats. */
export function formatPhoneNumber(value: string): string {
  return formatNorthAmericanPhone(value) ?? value;
}

// Keep each selection endpoint beside the same digit when separators change.
function phoneCaret(value: string, formatted: string, position: number) {
  let remaining = value.slice(0, position).replace(/[^\d+xX]/g, "").length;
  if (!remaining) return 0;
  for (let index = 0; index < formatted.length; index++) {
    if (/[\d+xX]/.test(formatted[index]) && --remaining === 0) return index + 1;
  }
  return formatted.length;
}

export function initPhoneInputs(element: HTMLFormElement) {
  for (const input of element.querySelectorAll<HTMLInputElement>(
    'input[type="tel"]',
  )) {
    const update = (event?: Event) => {
      if (event instanceof InputEvent && event.isComposing) return;
      const value = input.value;
      const formatted = formatPhoneNumber(value);
      if (value === formatted) return;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const direction = input.selectionDirection;
      input.value = formatted;
      if (document.activeElement === input && start !== null && end !== null)
        input.setSelectionRange(
          phoneCaret(value, formatted, start),
          phoneCaret(value, formatted, end),
          direction ?? undefined,
        );
    };
    input.addEventListener("beforeinput", (event) => {
      const start = input.selectionStart;
      if (
        !(event instanceof InputEvent) ||
        event.isComposing ||
        start === null ||
        start !== input.selectionEnd ||
        input.value !== formatNorthAmericanPhone(input.value)
      )
        return;
      // Delete the adjacent digit too, rather than continually re-inserting a dash.
      if (
        event.inputType === "deleteContentBackward" &&
        input.value[start - 1] === "-"
      )
        input.setSelectionRange(Math.max(0, start - 2), start);
      else if (
        event.inputType === "deleteContentForward" &&
        input.value[start] === "-"
      )
        input.setSelectionRange(start, start + 2);
    });
    input.addEventListener("input", update);
    input.addEventListener("change", update);
    input.addEventListener("compositionend", update);
    element.addEventListener("reset", () => queueMicrotask(update));
    update();
  }
}
