import {
  countWords,
  motivationMaxWords,
  motivationWordLimitError,
  trainingRequiredError,
  trainingExclusiveError,
  experienceRequiredError,
  experienceExclusiveError,
  profileFormSections,
  type ApplicationAnswers,
} from "../data/application";
import { mergeAnswers } from "../data/answer-merge";
import { renderAnswerConflicts } from "./answer-conflicts";
import { profileAnswerRows } from "../data/profile-answers";
import {
  readDateInputs,
  saveDateInputDefaults,
  setDateInputActive,
  restoreDateInputs,
} from "./date-input";

const requestFailed = "The request failed. Please try again.";

export function accountErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return requestFailed;
  const failure = error as {
    status?: number;
    statusText?: string;
    message?: string;
    error?: { message?: string };
  };
  // Better Fetch puts the API's message in `error`; Error.message can be just "429".
  const detail = failure.error?.message;
  if (detail && !/^\d{3}$/.test(detail)) return detail;
  if (failure.status === 429)
    return "Too many requests. Please wait before trying again.";
  if (failure.status && failure.status >= 500)
    return "This service is temporarily unavailable. Please try again later.";
  if (error instanceof TypeError)
    return "We could not connect. Check your connection and try again.";
  if (
    failure.message &&
    !/^\d{3}$/.test(failure.message) &&
    failure.message !== failure.statusText
  )
    return failure.message;
  return requestFailed;
}

export function emailCodeErrorMessage(error: unknown): string {
  const code = (error as { error?: { code?: string } } | null)?.error?.code;
  if (code === "OTP_EXPIRED")
    return "That sign-in code has expired. Choose Resend code for a new code and link sent to the same email.";
  // Better Auth also uses INVALID_OTP when a code/link was already consumed.
  if (code === "INVALID_OTP")
    return "Invalid sign-in code. It may be incorrect, expired, or already used. Try the latest email or choose Resend code.";
  return accountErrorMessage(error);
}

export function showFormMessage(
  element: Element,
  text: string,
  kind: "error" | "success" = "error",
) {
  const target = element.querySelector<HTMLElement>("[data-form-message]");
  if (!target) return;
  target.dataset.messageKind = kind;
  target.setAttribute("role", kind === "error" ? "alert" : "status");
  target.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  target.textContent = text;
  target.hidden = false;
}

export function clearFormMessage(element: Element) {
  const target = element.querySelector<HTMLElement>("[data-form-message]");
  if (!target) return;
  target.hidden = true;
  target.textContent = "";
  delete target.dataset.messageKind;
}

export function initMedicCertifications(element: HTMLFormElement) {
  const section = element.querySelector<HTMLElement>(
    "[data-medic-certifications]",
  );
  const medic = element.querySelector<HTMLInputElement>(
    '[name="teams"][value="medic"]',
  );
  if (!section || !medic) return;
  const medicalFields = section.closest<HTMLElement>("[data-medic-details]")!;
  const fields = [
    ...section.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ];
  const other = section.querySelector<HTMLInputElement>('[value="other"]');
  const training = element.querySelector<HTMLElement>("[data-other-training]");
  const experience = training?.querySelector<HTMLTextAreaElement>("textarea");
  const expiry = element.querySelector<HTMLFieldSetElement>(
    "[data-certification-expiry]",
  );
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let expanded = !medicalFields.hidden;
  let transition: Animation | undefined;
  const finishTransition = () => {
    medicalFields.hidden = !expanded;
    transition?.cancel();
    transition = undefined;
    delete medicalFields.dataset.transitioning;
  };
  const reveal = (active: boolean) => {
    if (!active && medicalFields.contains(document.activeElement))
      medic.focus({ preventScroll: true });
    // Remove collapsing controls from focus/accessibility immediately, not at
    // the end of their visual transition. Keep their draft answers intact.
    medicalFields.inert = !active;
    medicalFields.setAttribute("aria-hidden", String(!active));
    medic.setAttribute("aria-expanded", String(active));
    if (expanded === active) return;
    expanded = active;
    const height = medicalFields.getBoundingClientRect().height;
    const opacity = getComputedStyle(medicalFields).opacity;
    transition?.cancel();
    medicalFields.hidden = false;
    if (reducedMotion.matches || !medicalFields.getClientRects().length) {
      finishTransition();
      return;
    }
    medicalFields.dataset.transitioning = "";
    transition = medicalFields.animate(
      [
        { height: `${height}px`, opacity: height ? opacity : 0 },
        {
          height: `${active ? medicalFields.scrollHeight : 0}px`,
          opacity: active ? 1 : 0,
        },
      ],
      { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "both" },
    );
    transition.onfinish = finishTransition;
  };
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) finishTransition();
  });
  const update = () => {
    // Retain checked answers in FormData and drafts without hidden validation.
    for (const field of fields) field.required = medic.checked;
    if (expiry) {
      setDateInputActive(expiry, medic.checked);
      // The enclosing reveal owns visibility while the date validator still
      // deactivates required/custom validity synchronously on collapse.
      expiry.hidden = false;
    }
    if (training && experience) {
      const active = medic.checked && Boolean(other?.checked);
      training.hidden = !other?.checked;
      experience.required = active;
      experience.readOnly = !active;
      experience.setCustomValidity(
        active && !experience.value.trim()
          ? "Describe your other training and experience."
          : "",
      );
    }
    reveal(medic.checked);
  };
  medic.addEventListener("change", update);
  section.addEventListener("change", update);
  experience?.addEventListener("input", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}

export function initRelevantTraining(element: HTMLFormElement) {
  for (const section of element.querySelectorAll<HTMLElement>(
    "[data-relevant-training]",
  )) {
    const name = section.dataset.relevantTraining!;
    const experience = name === "relevantExperience";
    const requiredError = experience
      ? experienceRequiredError
      : trainingRequiredError;
    const exclusiveError = experience
      ? experienceExclusiveError
      : trainingExclusiveError;
    const choices = [
      ...section.querySelectorAll<HTMLInputElement>(`[name="${name}"]`),
    ];
    const first = choices[0];
    const other = choices.find((choice) => choice.value === "other");
    const none = choices.find((choice) => choice.value === "none");
    const feedback = section?.querySelector<HTMLElement>(
      `[data-error="${name}"] span`,
    );
    const details = section.querySelector<HTMLElement>(
      experience
        ? "[data-other-relevant-experience]"
        : "[data-other-relevant-training]",
    );
    const input = details?.querySelector<HTMLTextAreaElement>("textarea");
    if (!first || !other || !none || !details || !input) continue;
    const update = () => {
      const selected = choices.filter((choice) => choice.checked);
      const required =
        section.dataset.trainingRequired !== "false" ||
        // A legacy blank answer becomes required once an explicit answer is saved.
        choices.some((choice) => choice.defaultChecked);
      first.required = required && !selected.length;
      const error =
        none.checked && selected.length > 1
          ? exclusiveError
          : first.required
            ? requiredError
            : "";
      first.setCustomValidity(error);
      if (feedback) feedback.textContent = error || requiredError;
      details.hidden = !other.checked;
      input.required = other.checked;
      input.readOnly = !other.checked;
      input.setCustomValidity(
        other.checked && !input.value.trim()
          ? `Describe your other relevant ${experience ? "experience" : "training"}.`
          : "",
      );
    };
    const updateSelection = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement &&
        target.name === name &&
        target.checked
      ) {
        if (target === none) {
          for (const choice of choices)
            if (choice !== none) choice.checked = false;
        } else none.checked = false;
      }
      update();
    };
    // Resolve exclusivity before form-level listeners back up a checkbox input.
    section.addEventListener("input", updateSelection);
    section.addEventListener("change", updateSelection);
    element.addEventListener("reset", () => queueMicrotask(update));
    update();
  }
}

export function initReferralSources(element: HTMLFormElement) {
  const section = element.querySelector<HTMLElement>("[data-referral-sources]");
  const choices = [
    ...(section?.querySelectorAll<HTMLInputElement>(
      '[name="heardAboutUsSources"]',
    ) ?? []),
  ];
  const first = choices[0];
  const other = choices.find((choice) => choice.value === "other");
  const details = section?.querySelector<HTMLElement>("[data-other-referral]");
  const input = details?.querySelector<HTMLInputElement>("input");
  if (!section || !first || !other || !details || !input) return;
  const update = () => {
    const selected = choices.some((choice) => choice.checked);
    first.required = !selected;
    first.setCustomValidity(
      selected ? "" : "Select at least one way you found out about us.",
    );
    details.hidden = !other.checked;
    input.required = other.checked;
    input.disabled = !other.checked;
    if (!other.checked) input.value = "";
    input.setCustomValidity(
      other.checked && !input.value.trim()
        ? "Briefly describe how you found out about us."
        : "",
    );
  };
  section.addEventListener("change", update);
  input.addEventListener("input", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}

export function initMotivationWordLimit(element: HTMLFormElement) {
  const input = element.querySelector<HTMLTextAreaElement>(
    'textarea[name="motivation"]',
  );
  const feedback = element.querySelector<HTMLElement>(
    '[data-error="motivation"] span',
  );
  if (!input) return;
  const update = () => {
    const words = countWords(input.value);
    const over = words - motivationMaxWords;
    const error =
      input.required && words === 0
        ? "This field is required."
        : over > 0
          ? motivationWordLimitError
          : "";
    input.setCustomValidity(input.readOnly ? "" : error);
    if (over > 0 && !input.readOnly) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    if (feedback) feedback.textContent = error || "This field is required.";
  };
  input.addEventListener("input", update);
  input.addEventListener("change", update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
}

export function initAccountFormChanges(element: HTMLFormElement) {
  const sections = [
    ...element.querySelectorAll<HTMLElement>("[data-profile-section]"),
  ].map((section) => ({
    section,
    fields: section.querySelector<HTMLFieldSetElement>(
      "[data-profile-fields]",
    )!,
    summary: section.querySelector<HTMLElement>("[data-profile-answers]")!,
    edit: section.querySelector<HTMLButtonElement>("[data-profile-edit]")!,
    save: section.querySelector<HTMLButtonElement>('button[type="submit"]')!,
    cancel: section.querySelector<HTMLButtonElement>("[data-profile-cancel]")!,
  }));
  const summaries = sections.map(({ summary }) => summary);
  const medical = element.querySelector<HTMLElement>(
    "[data-profile-medical-fields]",
  )!;
  const medicalHome = medical.parentElement!;
  const teamTraining = element.querySelector<HTMLElement>(
    "[data-profile-team-training]",
  )!;
  const feedback = element.querySelector<HTMLElement>("[data-form-message]")!;
  let active: (typeof sections)[number] | undefined;
  let baseline = JSON.parse(
    element.dataset.profileBaseline ?? "null",
  ) as ApplicationAnswers;
  let conflicts: (keyof ApplicationAnswers)[][] = [];
  const conflictPanel = document.createElement("div");
  conflictPanel.setAttribute("role", "group");
  conflictPanel.setAttribute("aria-label", "Conflicting profile answers");
  conflictPanel.hidden = true;
  // Unnamed partial edits can leave the canonical value unchanged. Snapshot the
  // exact parts per request so a late save cannot mark newer edits as saved.
  let savedDates = readDateInputs(element);
  const submittedDates = new WeakMap<FormData, Record<string, string>>();
  const renderSavedAnswers = (values: FormData) => {
    const answers = {
      ...Object.fromEntries(
        [...values].map(([name, value]) => [name, String(value).trim()]),
      ),
      teams: values.getAll("teams").map(String),
      certifications: values.getAll("certifications").map(String),
      training: values.getAll("training").map(String),
      relevantExperience: values.getAll("relevantExperience").map(String),
    };
    for (const section of profileFormSections()) {
      const summary = [...summaries].find(
        (summary) => summary.dataset.profileAnswers === section.key,
      );
      if (!summary) continue;
      for (const row of profileAnswerRows(section, answers)) {
        const target = summary.querySelector<HTMLElement>(
          `[data-profile-answer="${row.name}"]`,
        );
        const value = target?.querySelector("dd");
        if (!target || !value) continue;
        target.hidden = Boolean(row.hidden);
        if (Array.isArray(row.value) && row.value.length) {
          const list = document.createElement("ul");
          for (const answer of row.value) {
            const item = document.createElement("li");
            item.textContent = answer;
            list.appendChild(item);
          }
          value.replaceChildren(list);
        } else {
          value.textContent = Array.isArray(row.value)
            ? "None selected"
            : row.value || "Not provided";
        }
      }
    }
  };
  // Profile answers are text and checkbox values; the server trims text on save.
  const snapshot = (values: FormData) =>
    JSON.stringify(
      [...values]
        .map(([name, value]) => [name, String(value).trim()])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  // Only the active fieldset participates in native validation/FormData. Retain
  // the complete saved payload explicitly: the API is not a section/PATCH API.
  for (const { fields } of sections) fields.disabled = false;
  let saved = new FormData(element);
  // Retired team choices have no editor control; unrelated saves retain them.
  saved.delete("teams");
  for (const team of baseline.teams) saved.append("teams", team);
  // Legacy non-Medic profiles may have multiple saved certifications that the
  // single-choice editor cannot represent. Unrelated section saves retain them.
  saved.delete("certifications");
  for (const certification of JSON.parse(
    element.dataset.profileCertifications ?? "[]",
  ))
    saved.append("certifications", certification);
  for (const { fields } of sections) fields.disabled = true;
  renderSavedAnswers(saved);
  const values = () => {
    const dates = readDateInputs(element);
    const result = new FormData();
    for (const [name, value] of saved) result.append(name, value);
    if (active) {
      // No radio is selected for an unrepresentable legacy multiselect answer.
      // Keep it until a replacement is explicitly chosen, even in Team interests.
      const retainCertifications =
        saved.getAll("certifications").length > 1 &&
        !medical.querySelector("input:checked");
      // Delete unchecked choices too, not just entries present in FormData.
      for (const control of active.fields.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >("[name]"))
        if (!retainCertifications || control.name !== "certifications")
          result.delete(control.name);
      for (const [name, value] of new FormData(element))
        if (!retainCertifications || name !== "certifications")
          result.append(name, value);
    }
    submittedDates.set(result, dates);
    return result;
  };
  const changed = () =>
    Boolean(active) &&
    (snapshot(values()) !== snapshot(saved) ||
      Object.entries(readDateInputs(active!.fields)).some(
        ([name, value]) => value !== savedDates[name],
      ));
  const setEditing = (next?: (typeof sections)[number]) => {
    const restoreFocus =
      active?.section.contains(document.activeElement) ||
      document.activeElement === document.body;
    const previous = active;
    active = next;
    // Medic selection and its required qualifications must save atomically.
    // Reuse the same controls inside Team interests while it is being edited;
    // Training and safety (and every unrelated section) remains saved text.
    const destination =
      next?.fields.dataset.profileFields === "team-interests"
        ? teamTraining
        : medicalHome;
    if (destination === teamTraining) destination.appendChild(medical);
    else destination.insertBefore(medical, destination.firstChild);
    for (const section of sections) {
      const editing = section === next;
      section.edit.hidden = editing;
      section.edit.setAttribute("aria-expanded", String(editing));
      section.fields.disabled = !editing;
      section.fields.hidden = !editing;
      section.summary.hidden = editing;
    }
    if (next) {
      clearFormMessage(element);
      next.section.appendChild(feedback);
      next.fields
        .querySelector<HTMLElement>(
          'input:not([type="hidden"]):enabled:not([readonly])',
        )
        ?.focus();
    }
    update();
    if (!next && restoreFocus)
      queueMicrotask(() => previous?.edit.focus({ preventScroll: true }));
  };
  for (const section of sections) {
    section.edit.addEventListener("click", () => {
      if (!active && !element.dataset.submitting) setEditing(section);
    });
    const { cancel } = section;
    cancel.addEventListener("click", () => {
      if (element.dataset.submitting) return;
      element.reset();
      conflicts = [];
      conflictPanel.hidden = true;
      clearFormMessage(element);
      setEditing();
    });
  }
  const update = () => {
    const submitting = Boolean(element.dataset.submitting);
    const dirty = changed();
    for (const section of sections) {
      section.edit.disabled = Boolean(active) || submitting;
      section.edit.title =
        active && section !== active
          ? "Save or cancel the open section before editing another."
          : "";
      // Leave only the open section's submit button in the form's implicit
      // Enter-key submission order; earlier hidden buttons must not intercept it.
      section.save.type = section === active ? "submit" : "button";
      section.save.disabled =
        section !== active || submitting || !dirty || Boolean(conflicts.length);
      section.cancel.disabled = submitting;
    }
  };
  for (const event of ["input", "change"])
    element.addEventListener(event, update);
  element.addEventListener("reset", () => queueMicrotask(update));
  update();
  const asAnswers = (
    data: FormData,
    dates?: Record<string, string>,
  ): ApplicationAnswers => {
    const result = { ...baseline };
    for (const key of Object.keys(result) as (keyof ApplicationAnswers)[]) {
      if (
        Array.isArray(result[key]) &&
        (data.has(key) ||
          [
            "teams",
            "certifications",
            "training",
            "relevantExperience",
          ].includes(key))
      )
        Object.assign(result, { [key]: data.getAll(key).map(String) });
      else if (data.has(key))
        Object.assign(result, { [key]: String(data.get(key)).trim() });
    }
    return { ...result, ...dates };
  };
  const restoreAnswers = (answers: ApplicationAnswers) => {
    for (const control of element.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >("[name]")) {
      const value = answers[control.name as keyof ApplicationAnswers];
      if (value === undefined) continue;
      if (
        control instanceof HTMLInputElement &&
        ["radio", "checkbox"].includes(control.type)
      )
        control.checked =
          Array.isArray(value) &&
          (control.type !== "radio" || value.length === 1) &&
          value.includes(control.value);
      else if (typeof value === "string") control.value = value;
    }
    restoreDateInputs(element, { ...answers });
    for (const control of element.querySelectorAll("input, textarea"))
      control.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const renderConflicts = () => {
    conflictPanel.hidden = !conflicts.length;
    if (!conflicts.length) return;
    active?.section.appendChild(conflictPanel);
    renderAnswerConflicts(
      conflictPanel,
      conflicts,
      asAnswers(values(), readDateInputs(element)),
      baseline,
      (fields, source) => {
        if (source === "account") {
          const current = asAnswers(values(), readDateInputs(element));
          for (const field of fields)
            Object.assign(current, { [field]: baseline[field] });
          restoreAnswers(current);
        }
        conflicts = conflicts.filter((group) => group !== fields);
        renderConflicts();
        update();
      },
    );
  };
  const adopt = (latest: ApplicationAnswers, current: ApplicationAnswers) => {
    baseline = latest;
    element.dataset.profileBaseline = JSON.stringify(latest);
    const next = new FormData();
    for (const name of new Set([...saved.keys(), ...Object.keys(latest)])) {
      const value = latest[name as keyof ApplicationAnswers];
      if (Array.isArray(value))
        for (const item of value) next.append(name, item);
      else if (typeof value === "string") next.set(name, value);
      else for (const item of saved.getAll(name)) next.append(name, item);
    }
    saved = next;
    savedDates = {
      birthDate: latest.birthDate,
      certificationExpiry: latest.certificationExpiry,
    };
    restoreAnswers(current);
    saveDateInputDefaults(element, savedDates);
    for (const control of element.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >("input[name], textarea[name]")) {
      const value = control.value;
      if (
        control instanceof HTMLInputElement &&
        ["radio", "checkbox"].includes(control.type)
      ) {
        const checked = control.checked;
        control.defaultChecked = saved
          .getAll(control.name)
          .includes(control.value);
        control.checked = checked;
      } else {
        control.defaultValue = String(saved.get(control.name) ?? "");
        control.value = value;
      }
    }
    renderSavedAnswers(saved);
    renderConflicts();
    update();
  };
  return {
    update,
    values,
    submitButton: () => active?.save,
    conflicted(error: unknown) {
      const latest = (error as { latest?: ApplicationAnswers })?.latest;
      if (!latest) return;
      const merged = mergeAnswers(
        baseline,
        asAnswers(values(), readDateInputs(element)),
        latest,
      );
      conflicts = merged.conflicts;
      adopt(latest, merged.answers);
    },
    markSaved(submitted: FormData, latest?: ApplicationAnswers) {
      if (!latest) return;
      const merged = mergeAnswers(
        asAnswers(submitted, submittedDates.get(submitted)),
        asAnswers(values(), readDateInputs(element)),
        latest,
      );
      conflicts = merged.conflicts;
      adopt(latest, merged.answers);
      if (!changed()) setEditing();
    },
  };
}
