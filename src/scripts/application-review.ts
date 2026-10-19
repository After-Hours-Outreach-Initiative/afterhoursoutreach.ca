import {
  applicationTeamOptions,
  certificationOptions,
  heardAboutUsOptions,
  trainingOptions,
} from "../data/application";
import { clearFormMessage } from "./account-forms";
import { syncBirthDate } from "./birth-date";

// Review and submission share this payload. Omit inactive answers from the
// outgoing copy without changing the draft controls used for back/edit navigation.
export function applicationSubmissionValues(
  element: HTMLFormElement,
): FormData {
  syncBirthDate(element);
  const values = new FormData(element);
  if (!values.getAll("teams").includes("medic")) {
    values.delete("certifications");
    values.set("certificationExpiry", "");
    values.set("experience", "");
  } else if (!values.getAll("certifications").includes("other")) {
    values.set("experience", "");
  }
  if (!values.getAll("training").includes("other"))
    values.set("otherTraining", "");
  if (!values.getAll("heardAboutUsSources").includes("other"))
    values.set("heardAboutUsOther", "");
  return values;
}

export function initApplicationReview(element: HTMLFormElement) {
  if (!element.hasAttribute("data-application")) return;
  const flow = element.closest("[data-application-flow]");
  const contents = flow?.querySelector<HTMLElement>(
    "[data-application-contents]",
  );
  const draftActions = flow?.querySelector<HTMLElement>(
    "[data-application-draft-actions]",
  );
  const questions = element.querySelector<HTMLElement>(
    "[data-application-questions]",
  );
  const review = element.querySelector<HTMLFieldSetElement>(
    "[data-application-review-step]",
  );
  const reviewButtons = flow?.querySelectorAll<HTMLButtonElement>(
    "[data-application-review]",
  );
  const submitButton = element.querySelector<HTMLButtonElement>(
    "[data-application-submit]",
  );
  if (!questions || !review || !reviewButtons?.length || !submitButton) return;

  const originalTitle = document.title;
  let step: "questions" | "review" = "questions";
  let editTarget: string | undefined;
  const state = (next: typeof step) => ({
    ...history.state,
    applicationStep: next,
  });
  // Resumed drafts always return to the answers and require a fresh review.
  history.replaceState(state("questions"), "");
  for (const button of reviewButtons) button.disabled = false;

  const focus = (target: HTMLElement | null) => {
    // History traversal restores scroll after popstate. Focus/scroll afterwards,
    // especially when Edit targets a different section from the previous scroll.
    requestAnimationFrame(() => {
      if (!target || target.closest("[hidden]")) return;
      target.focus({ preventScroll: true });
      // A sticky disclosure's own position cannot return to the answers' start.
      const scrollTarget = target.closest("[data-application-contents]")
        ? questions
        : target;
      scrollTarget.scrollIntoView({ block: "start" });
    });
  };
  const display = (next: typeof step, moveFocus = true) => {
    step = next;
    questions.hidden = next !== "questions";
    if (contents) contents.hidden = next !== "questions";
    if (draftActions) draftActions.hidden = next !== "questions";
    review.hidden = next !== "review";
    // The hidden acknowledgement must not block first-step native validation.
    // Questions stay enabled on review so FormData still contains every answer.
    review.disabled = next !== "review";
    document.title =
      next === "review"
        ? `Review application | ${originalTitle}`
        : originalTitle;
    clearFormMessage(element);
    if (!moveFocus) return;
    const section = editTarget ? document.getElementById(editTarget) : null;
    editTarget = undefined;
    if (
      next === "questions" &&
      section instanceof HTMLDetailsElement &&
      questions.contains(section)
    ) {
      section.open = true;
      focus(section.querySelector<HTMLElement>("summary"));
    } else {
      focus(
        next === "questions"
          ? (questions.querySelector<HTMLElement>(
              "[data-application-section] > summary",
            ) ??
              contents?.querySelector<HTMLElement>("summary") ??
              null)
          : review.querySelector<HTMLElement>(
              "[data-application-step-heading]",
            ),
      );
    }
  };
  const render = () => {
    const values = applicationSubmissionValues(element);
    const medic = values.getAll("teams").includes("medic");
    const conditions: Record<string, boolean> = {
      medic,
      "other-certification":
        medic && values.getAll("certifications").includes("other"),
      "other-training": values.getAll("training").includes("other"),
      "other-referral": values.getAll("heardAboutUsSources").includes("other"),
    };
    for (const row of review.querySelectorAll<HTMLElement>(
      "[data-review-condition]",
    ))
      row.hidden = !conditions[row.dataset.reviewCondition!];
    const choices: Record<string, readonly { value: string; label: string }[]> =
      {
        teams: applicationTeamOptions,
        certifications: certificationOptions,
        training: trainingOptions,
        heardAboutUsSources: heardAboutUsOptions,
      };
    for (const answer of review.querySelectorAll<HTMLElement>(
      "[data-review-answer]",
    )) {
      const name = answer.dataset.reviewAnswer!;
      if (name === "email") continue;
      if (choices[name]) {
        const selected = choices[name].filter((option) =>
          values.getAll(name).includes(option.value),
        );
        if (!selected.length) answer.textContent = "None selected";
        else {
          const list = document.createElement("ul");
          for (const option of selected) {
            const item = document.createElement("li");
            item.textContent = option.label;
            list.appendChild(item);
          }
          answer.replaceChildren(list);
        }
      } else {
        const value = String(values.get(name) ?? "").trim();
        answer.textContent =
          value && ["birthDate", "certificationExpiry"].includes(name)
            ? new Intl.DateTimeFormat("en-CA", {
                dateStyle: "long",
                timeZone: "UTC",
              }).format(new Date(`${value}T00:00:00Z`))
            : value || "Not provided";
      }
    }
  };
  element.addEventListener("application-draft-restored", () => {
    history.replaceState(state("questions"), "");
    display("questions", false);
  });
  element.addEventListener("submit", (event) => {
    if (step === "questions") {
      event.preventDefault();
      event.stopPropagation();
      if (element.dataset.submitting) return;
      // Native constraint validation has already opened/focused invalid sections.
      render();
      history.pushState(state("review"), "");
      display("review");
    } else if (event.submitter !== submitButton) {
      // An implicit Enter or stale first-step action must never submit a draft.
      event.preventDefault();
      event.stopPropagation();
    }
  });
  element.addEventListener(
    "invalid",
    (event) => {
      if (
        step !== "review" ||
        !(event.target instanceof Node) ||
        !questions.contains(event.target)
      )
        return;
      // If a hidden answer becomes invalid, return before native focus is attempted.
      history.replaceState(state("questions"), "");
      display("questions", false);
    },
    true,
  );
  for (const button of review.querySelectorAll<HTMLButtonElement>(
    "[data-application-edit]",
  )) {
    button.addEventListener("click", () => {
      if (element.dataset.submitting) return;
      editTarget = button.dataset.applicationEdit || undefined;
      history.back();
    });
  }
  window.addEventListener("popstate", (event) => {
    if (event.state?.applicationStep === "review") {
      // Forward must revalidate/rebuild any answers changed after going Back.
      display("questions", false);
      if (element.reportValidity()) {
        render();
        display("review");
      } else {
        history.replaceState(state("questions"), "");
        focus(
          questions.querySelector<HTMLElement>(
            "input:invalid, textarea:invalid",
          ),
        );
      }
    } else if (step === "review") display("questions");
  });
}
