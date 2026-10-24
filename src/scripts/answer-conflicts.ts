import { answerLabel } from "../data/answer-merge";

export function renderAnswerConflicts<T extends object>(
  container: HTMLElement,
  groups: (keyof T & string)[][],
  local: T,
  latest: T,
  choose: (fields: (keyof T & string)[], source: "local" | "account") => void,
  field?: keyof T & string,
) {
  container.replaceChildren();
  for (const fields of groups) {
    const section = document.createElement("div");
    const label = answerLabel(field ? [field] : fields);
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", `Conflicting answers for ${label}`);
    const heading = document.createElement("p");
    heading.textContent = `${field ? "Sync conflict. " : ""}Choose answers for ${answerLabel(fields)}:`;
    section.appendChild(heading);
    for (const [source, answers, label] of [
      ["local", local, "Keep my answers"],
      ["account", latest, "Use account answers"],
    ] as const) {
      const detail = document.createElement("p");
      detail.textContent = `${source === "local" ? "This page" : "Account"}: ${fields.map((field) => `${answerLabel([field])}: ${Array.isArray(answers[field]) ? (answers[field] as string[]).join(", ") || "None selected" : String(answers[field] || "Not provided")}`).join("; ")}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-quiet mt-2";
      button.textContent = label;
      if (field)
        button.setAttribute(
          "aria-label",
          `${label} for ${answerLabel([field])}`,
        );
      button.addEventListener("click", () => choose(fields, source));
      section.appendChild(detail);
      section.appendChild(button);
    }
    container.appendChild(section);
  }
}
