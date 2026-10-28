import { createDialogHeader } from "../../scripts/dialog";

type DiscordOutcome = "authorize" | "screening" | "unavailable";

/** Replace Discord's external authorization screen, not the website's real UI. */
export function localDiscordDialog(): Promise<DiscordOutcome | null> {
  if (!import.meta.env.DEV)
    throw new Error("Discord simulation is local-development only.");
  const dialog = document.createElement("dialog");
  dialog.className = "dialog-pop dialog-frame";
  const heading = document.createElement("h2");
  heading.id = "local-discord-heading";
  heading.textContent = "Authorize AHOI Bot";
  dialog.setAttribute("aria-labelledby", heading.id);
  const { header, close } = createDialogHeader(
    heading,
    "Cancel Discord connection",
  );
  close.addEventListener("click", () => dialog.close());
  const content = document.createElement("div");
  content.className = "dialog-body space-y-4";
  for (const text of [
    "Local simulation. No real Discord account is connected or server joined.",
    "AHOI Bot would like to access your Discord identity and join the After Hours Outreach server as aho_volunteer.",
    "After joining, your access to volunteer channels follows your volunteer status.",
  ]) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    content.appendChild(paragraph);
  }
  const actions = document.createElement("div");
  actions.className = "dialog-footer";
  for (const [outcome, label] of [
    ["authorize", "Authorize connection"],
    ["screening", "Simulate server rules required"],
    ["unavailable", "Simulate Discord unavailable"],
    ["", "Cancel"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      outcome === "authorize" ? "btn btn-primary" : "btn btn-outline";
    button.textContent = label;
    button.addEventListener("click", () => dialog.close(outcome));
    actions.appendChild(button);
  }
  for (const child of [header, content, actions]) dialog.appendChild(child);
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const outcome = dialog.returnValue;
        dialog.remove();
        resolve(
          outcome === "authorize" ||
            outcome === "screening" ||
            outcome === "unavailable"
            ? outcome
            : null,
        );
      },
      { once: true },
    );
    dialog.showModal();
  });
}
