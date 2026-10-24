import type { ApplicationDraftAnswers } from "../data/application-draft";
import { sameAnswer } from "../data/answer-merge";
import { renderAnswerConflicts } from "./answer-conflicts";

type Field = keyof ApplicationDraftAnswers;
type Choose = (fields: Field[], source: "local" | "account") => void;

export function initApplicationConflicts(form: HTMLFormElement) {
  const anchors = new Map(
    [...form.querySelectorAll<HTMLElement>("[data-error]")].map((anchor) => [
      anchor.dataset.error!,
      anchor,
    ]),
  );
  const panels = new Map<
    Field,
    {
      panel: HTMLElement;
      fields: Field[];
      snapshot: string;
      controls: HTMLElement[];
    }
  >();
  let onChoose: Choose;
  return (
    groups: Field[][],
    local: ApplicationDraftAnswers,
    latest: ApplicationDraftAnswers,
    choose: Choose,
  ) => {
    onChoose = choose;
    for (const anchor of anchors.values())
      delete anchor.dataset.draftConflicted;
    const active = new Set<Field>();
    for (const fields of groups) {
      const differing = fields.filter(
        (field) => !sameAnswer(local[field], latest[field]),
      );
      for (const field of fields) {
        const anchor = anchors.get(field);
        if (!anchor) continue;
        // Related fields remain one resolution unit, including fields in another
        // section or currently hidden behind a conditional choice.
        anchor.dataset.draftConflicted = "true";
        // Typing the account value is not itself an explicit resolution. Keep a
        // choice reachable until reconciliation or the user's choice clears it.
        if (
          !(differing.length ? differing : fields.slice(0, 1)).includes(field)
        )
          continue;
        active.add(field);
        let entry = panels.get(field);
        if (!entry) {
          const panel = document.createElement("div");
          panel.id = `${form.id}-conflict-${field}`;
          panel.dataset.draftConflict = field;
          panel.className = "volunteer-answer-conflict volunteer-wide";
          const date = anchor.closest<HTMLElement>("[data-date-input]");
          const controls = [
            ...(date ?? form).querySelectorAll<HTMLElement>(
              date ? 'input:not([type="hidden"])' : `[name="${field}"]`,
            ),
          ];
          for (const control of controls)
            control.setAttribute(
              "aria-describedby",
              [control.getAttribute("aria-describedby"), panel.id]
                .filter(Boolean)
                .join(" "),
            );
          entry = { panel, fields, snapshot: "", controls };
          panels.set(field, entry);
        }
        entry.fields = fields;
        // Keep controls reachable even when the differing answer is inactive
        // (e.g. retained Medic details while this page has Medic unchecked).
        let placement = anchor;
        for (
          let parent = anchor.parentElement;
          parent && !parent.matches(".volunteer-application-section");
          parent = parent.parentElement
        )
          if (parent.hidden || parent.inert) placement = parent;
        let next = placement.nextElementSibling;
        while (
          next?.hasAttribute("data-draft-conflict") &&
          next !== entry.panel
        )
          next = next.nextElementSibling;
        if (next !== entry.panel)
          placement.insertAdjacentElement("afterend", entry.panel);
        const snapshot = JSON.stringify(
          fields.map((name) => [name, local[name], latest[name]]),
        );
        if (entry.snapshot === snapshot) continue;
        entry.snapshot = snapshot;
        const current = entry;
        renderAnswerConflicts(
          entry.panel,
          [fields],
          local,
          latest,
          (_fields, source) => {
            const focused = current.panel.contains(document.activeElement);
            onChoose(current.fields, source);
            if (!focused || current.panel.isConnected) return;
            const next = [
              ...form.querySelectorAll<HTMLButtonElement>(
                "[data-draft-conflict] button",
              ),
              ...current.controls,
            ].find((control) => !control.closest("[hidden], [inert]"));
            next?.focus();
          },
          field,
        );
      }
    }
    for (const [field, { panel, controls }] of panels) {
      if (active.has(field)) continue;
      panel.remove();
      for (const control of controls) {
        const descriptions = control
          .getAttribute("aria-describedby")
          ?.split(/\s+/)
          .filter((id) => id !== panel.id)
          .join(" ");
        if (descriptions)
          control.setAttribute("aria-describedby", descriptions);
        else control.removeAttribute("aria-describedby");
      }
      panels.delete(field);
    }
    form.dispatchEvent(new Event("application-draft-conflicts-changed"));
  };
}
