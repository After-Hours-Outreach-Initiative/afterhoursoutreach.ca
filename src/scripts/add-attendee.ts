import { publicAttendeeName } from "../data/event-roster";
import { setCompactPersonName } from "./compact-person-name";

export function syncAttendeePreview(form: HTMLFormElement) {
  const values = new FormData(form);
  const enteredName = String(values.get("name") ?? "");
  const name = enteredName.trim()
    ? publicAttendeeName(null, null, enteredName)
    : "Name";
  for (const preview of form.querySelectorAll<HTMLElement>(
    "[data-attendee-preview-medic]",
  )) {
    preview.hidden =
      preview.dataset.attendeePreviewMedic !== String(values.has("medic")) ||
      preview.dataset.attendeePreviewNew !== String(values.has("newVolunteer"));
    setCompactPersonName(
      preview.querySelector<HTMLElement>(".compact-person-name")!,
      name,
    );
  }
}

export function initAttendeePreviews() {
  document.addEventListener("input", (event) => {
    if (!(event.target instanceof Element)) return;
    const form = event.target.closest<HTMLFormElement>("[data-add-attendee]");
    if (form) syncAttendeePreview(form);
  });
}
