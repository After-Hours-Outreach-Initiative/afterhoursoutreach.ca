import closeIcon from "../components/icons/CloseIcon.svg?raw";
import "../styles/dialog.css";

/** Keep runtime-created dialogs consistent with the Astro dialog header. */
export function createDialogHeader(
  heading: HTMLHeadingElement,
  closeLabel = "Close",
) {
  const header = document.createElement("div");
  header.className = "dialog-header";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-quiet dialog-close";
  close.setAttribute("aria-label", closeLabel);
  close.innerHTML = closeIcon;
  header.appendChild(heading);
  header.appendChild(close);
  return { header, close };
}
