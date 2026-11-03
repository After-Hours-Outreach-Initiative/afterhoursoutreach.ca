import { compactPersonDisplayName } from "../data/person-name";

export function setCompactPersonName(element: HTMLElement, name: string) {
  const compact = compactPersonDisplayName(name);
  const visible = document.createElement("span");
  visible.textContent = compact;
  element.replaceChildren(visible);
  if (compact !== name) {
    element.title = name;
    visible.setAttribute("aria-hidden", "true");
    const accessible = document.createElement("span");
    accessible.className = "sr-only";
    accessible.textContent = name;
    element.appendChild(accessible);
  } else {
    element.removeAttribute("title");
  }
}
