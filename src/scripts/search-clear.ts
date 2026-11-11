/**
 * Clear buttons inside search fields. Clearing reports an `input` event, so
 * each field's own search logic responds as if the person deleted the text.
 * The button hides itself through CSS while the field is empty.
 */
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("[data-search-clear]");
  const input = button
    ?.closest(".volunteer-search-field")
    ?.querySelector<HTMLInputElement>("input");
  if (!input) return;
  event.preventDefault();
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
});
