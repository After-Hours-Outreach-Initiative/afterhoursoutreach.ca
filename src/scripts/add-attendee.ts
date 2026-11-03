import type { SignupCandidate } from "../server/db/events";
import { InlineMorph } from "./inline-morph";
import { setCompactPersonName } from "./compact-person-name";
import { manualAttendeeCategory } from "../data/event-roster";

class AddAttendee extends HTMLElement {
  private controller?: AbortController;
  private searchController?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private morph = new InlineMorph();
  private candidates: SignupCandidate[] = [];
  private selected = 0;

  private get form() {
    return this.querySelector<HTMLFormElement>("form")!;
  }
  private get search() {
    return this.querySelector<HTMLInputElement>("[data-attendee-search]")!;
  }
  private get suggestions() {
    return this.querySelector<HTMLElement>("[data-attendee-suggestions]")!;
  }
  private get staged() {
    return this.querySelector<HTMLElement>("[data-attendee-staged]")!;
  }

  connectedCallback() {
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.addEventListener(
      "click",
      (event) => {
        if (!(event.target instanceof Element) || this.form.dataset.submitting)
          return;
        const button = event.target.closest<HTMLButtonElement>("button");
        if (button?.disabled) return;
        if (button?.matches("[data-attendee-open], [data-attendee-cancel]"))
          this.expand(button.hasAttribute("data-attendee-open"));
        if (button?.type === "submit") this.closeSuggestions();
        if (button?.matches("[data-attendee-manual]")) this.addManual();
        if (button?.matches("[data-attendee-remove]")) {
          const row = button.closest("[data-staged-row]")!;
          const nextFocus =
            row.nextElementSibling?.querySelector<HTMLButtonElement>(
              "[data-attendee-remove]",
            ) ??
            row.previousElementSibling?.querySelector<HTMLButtonElement>(
              "[data-attendee-remove]",
            ) ??
            this.querySelector<HTMLButtonElement>("[data-attendee-manual]")!;
          row.remove();
          this.staged.hidden = !this.staged.children.length;
          this.announce("Removed from the list.");
          this.closeSuggestions();
          nextFocus.focus({ preventScroll: true });
        }
        const option = event.target.closest<HTMLElement>(
          "[data-candidate-index]",
        );
        if (option) this.addCandidate(Number(option.dataset.candidateIndex));
      },
      { signal },
    );
    this.suggestions.addEventListener(
      "pointerdown",
      (event) => event.preventDefault(),
      { signal },
    );
    this.addEventListener(
      "pointerdown",
      (event) => {
        // Closing an inline result list on blur must not move a button between
        // pointerdown and click. Its click handler will close the list instead.
        if (
          document.activeElement === this.search &&
          event.target instanceof Element &&
          event.target.closest("button")
        )
          event.preventDefault();
      },
      { signal },
    );
    this.addEventListener(
      "input",
      (event) => {
        if (event.target === this.search) this.queueSearch();
        if (event.target instanceof Element) {
          const row = event.target.closest<HTMLElement>("[data-staged-row]");
          if (row?.querySelector("[data-manual-fields]:not([hidden])"))
            this.syncManual(row);
        }
      },
      { signal },
    );
    this.addEventListener(
      "focusout",
      (event) => {
        if (event.target === this.search) this.closeSuggestions();
      },
      { signal },
    );
    this.search.addEventListener(
      "focus",
      () => {
        if (this.search.value.trim()) this.queueSearch();
      },
      { signal },
    );
    this.addEventListener(
      "keydown",
      (event) => {
        if (this.form.dataset.submitting || event.isComposing) return;
        if (event.target === this.search) {
          if (
            ["ArrowDown", "ArrowUp", "Tab"].includes(event.key) &&
            !this.suggestions.hidden
          ) {
            event.preventDefault();
            const direction =
              event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)
                ? -1
                : 1;
            this.selected =
              (this.selected + direction + this.candidates.length) %
              this.candidates.length;
            this.selectOption();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (!this.suggestions.hidden) this.addCandidate(this.selected);
            return;
          }
        }
        if (event.key === "Escape" && this.hasAttribute("data-expanded")) {
          event.preventDefault();
          if (!this.suggestions.hidden) this.closeSuggestions();
          else this.expand(false);
        }
      },
      { signal },
    );
  }

  disconnectedCallback() {
    this.controller?.abort();
    this.closeSuggestions();
    this.morph.cancel();
  }

  private announce(text: string) {
    this.querySelector<HTMLElement>("[data-staged-message]")!.textContent =
      text;
  }

  private closeSuggestions() {
    clearTimeout(this.timer);
    this.searchController?.abort();
    this.suggestions.hidden = true;
    this.search.setAttribute("aria-expanded", "false");
    this.search.removeAttribute("aria-activedescendant");
    this.search.removeAttribute("aria-busy");
    this.querySelector<HTMLElement>("[data-search-message]")!.hidden = true;
  }

  private queueSearch() {
    this.closeSuggestions();
    if (this.search.value.trim())
      this.timer = setTimeout(() => void this.findCandidates(), 150);
  }

  private async findCandidates() {
    const controller = new AbortController();
    this.searchController = controller;
    const query = new URLSearchParams({
      id: String(new FormData(this.form).get("id")),
      q: this.search.value.trim(),
    });
    for (const row of this.staged.querySelectorAll<HTMLElement>(
      "[data-user-id]",
    ))
      query.append("exclude", row.dataset.userId!);
    const message = this.querySelector<HTMLElement>("[data-search-message]")!;
    this.search.setAttribute("aria-busy", "true");
    message.textContent = "Searching…";
    message.hidden = false;
    try {
      const response = await fetch(`/api/v1/events/volunteers?${query}`, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        volunteers: SignupCandidate[];
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          result.message || "Volunteers could not be found. Try again.",
        );
      if (controller.signal.aborted || this.form.dataset.submitting) return;
      this.candidates = result.volunteers.filter(
        (person) =>
          ![
            ...this.staged.querySelectorAll<HTMLElement>("[data-user-id]"),
          ].some((row) => row.dataset.userId === person.id),
      );
      this.suggestions.replaceChildren(
        ...this.candidates.map((person, index) => {
          const option = document.createElement("li");
          option.className = "event-roster-row";
          option.id = `${this.search.id}-option-${index}`;
          option.setAttribute("role", "option");
          option.dataset.candidateIndex = String(index);
          const details = document.createElement("div");
          details.className = "event-roster-details";
          details.appendChild(this.person(person));
          option.appendChild(details);
          return option;
        }),
      );
      this.selected = 0;
      this.suggestions.hidden = !this.candidates.length;
      this.search.setAttribute(
        "aria-expanded",
        String(this.candidates.length > 0),
      );
      message.textContent = this.candidates.length
        ? `${this.candidates.length} matching volunteers.`
        : "No matching eligible volunteers. You can add a name manually.";
      if (this.candidates.length) this.selectOption();
    } catch (error) {
      if (!controller.signal.aborted)
        message.textContent =
          error instanceof Error &&
          !(error instanceof TypeError) &&
          !(error instanceof SyntaxError)
            ? error.message
            : "Volunteers could not be found. Try again.";
    } finally {
      if (!controller.signal.aborted) this.search.removeAttribute("aria-busy");
    }
  }

  private selectOption() {
    [...this.suggestions.children].forEach((option, index) =>
      option.setAttribute("aria-selected", String(index === this.selected)),
    );
    const option = this.suggestions.children[this.selected] as HTMLElement;
    this.search.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  }

  private person(
    person: Pick<SignupCandidate, "name" | "category" | "medicMark"> & {
      role?: SignupCandidate["role"];
    },
  ) {
    const medic = person.category === "medic" || Boolean(person.medicMark);
    const template = this.querySelector<HTMLTemplateElement>(
      `[data-attendee-person-template="${person.category}-${medic}"]`,
    )!;
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    setCompactPersonName(
      fragment.querySelector<HTMLElement>(".compact-person-name")!,
      person.name,
    );
    const avatar = fragment.querySelector<HTMLElement>(".attendee-avatar")!;
    // These people are not registered yet; do not announce the roster's suffix.
    const label = avatar
      .getAttribute("aria-label")!
      .replace(": registered", "");
    avatar.setAttribute("aria-label", label);
    avatar.title = label;
    const gradient = fragment.querySelector("linearGradient");
    if (gradient) {
      const gradientId = `staged-avatar-${crypto.randomUUID()}`;
      gradient.id = gradientId;
      for (const shape of fragment.querySelectorAll("[fill^='url(']"))
        shape.setAttribute("fill", `url(#${gradientId})`);
    }
    const badges = this.querySelector<HTMLTemplateElement>(
      "[data-attendee-badges]",
    )!;
    for (const role of [
      ...(person.role === "organizer" ? ["organizer"] : []),
      ...(medic ? ["medic"] : []),
    ])
      fragment
        .querySelector(".event-roster-name")!
        .appendChild(
          badges.content
            .querySelector(`[data-volunteer-role="${role}"]`)!
            .cloneNode(true),
        );
    return fragment;
  }

  private newRow() {
    if (this.staged.children.length >= 100) {
      this.announce("Add up to 100 volunteers at a time.");
      return;
    }
    this.morph.cancel();
    const template = this.querySelector<HTMLTemplateElement>(
      "[data-attendee-row-template]",
    )!;
    const row = (template.content.cloneNode(true) as DocumentFragment)
      .firstElementChild as HTMLElement;
    this.staged.appendChild(row);
    this.staged.hidden = false;
    return row;
  }

  private addCandidate(index: number) {
    const person = this.candidates[index];
    if (
      !person ||
      [...this.staged.querySelectorAll<HTMLElement>("[data-user-id]")].some(
        (row) => row.dataset.userId === person.id,
      )
    )
      return;
    const row = this.newRow();
    if (!row) return;
    row.dataset.userId = person.id;
    row.querySelector("[data-staged-person]")!.appendChild(this.person(person));
    row.querySelector<HTMLInputElement>('[name="volunteers"]')!.value =
      JSON.stringify({ userId: person.id });
    row.querySelector("[data-manual-fields]")!.remove();
    row
      .querySelector("[data-attendee-remove]")!
      .setAttribute("aria-label", `Remove ${person.name} from list`);
    this.search.value = "";
    this.closeSuggestions();
    this.announce(`${person.name} added to the list.`);
  }

  private addManual() {
    this.closeSuggestions();
    const row = this.newRow();
    if (!row) return;
    row.querySelector<HTMLElement>("[data-manual-fields]")!.hidden = false;
    const name = row.querySelector<HTMLInputElement>("[data-manual-name]")!;
    name.id = `manual-name-${crypto.randomUUID()}`;
    row.querySelector("[data-manual-name-label]")!.setAttribute("for", name.id);
    for (const checkbox of row.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )) {
      checkbox.id = `${name.id}-${checkbox.name}`;
      checkbox.closest("label")!.htmlFor = checkbox.id;
    }
    this.syncManual(row);
    name.focus();
  }

  private syncManual(row: HTMLElement) {
    const name =
      row.querySelector<HTMLInputElement>("[data-manual-name]")!.value;
    const medic =
      row.querySelector<HTMLInputElement>('[name="medic"]')!.checked;
    const newVolunteer = row.querySelector<HTMLInputElement>(
      '[name="newVolunteer"]',
    )!.checked;
    const person = this.person({
      name: "",
      category: manualAttendeeCategory(medic, newVolunteer),
      medicMark: Number(medic),
    });
    // The textbox is the name in a manual row, not a separate name preview.
    person.querySelector(".compact-person-name")!.remove();
    // The role checkboxes already provide the badges for manual entries.
    for (const badge of person.querySelectorAll(".volunteer-role-badge"))
      badge.remove();
    const fields = row.querySelector<HTMLElement>("[data-manual-fields]")!;
    const existingAvatar = row.querySelector(".attendee-avatar");
    if (existingAvatar) {
      // Keep focused text/checkbox controls in place while changing the role.
      existingAvatar.replaceWith(person.querySelector(".attendee-avatar")!);
    } else {
      row.querySelector("[data-staged-person]")!.replaceChildren(person);
      const identity = row.querySelector(".event-roster-name")!;
      identity.insertBefore(fields, identity.firstChild);
    }
    row.querySelector<HTMLInputElement>('[name="volunteers"]')!.value =
      JSON.stringify({ name, medic, newVolunteer });
    row
      .querySelector("[data-attendee-remove]")!
      .setAttribute(
        "aria-label",
        `Remove ${name.trim() || "manual name"} from list`,
      );
  }

  private expand(expanded: boolean) {
    if (this.form.dataset.submitting) return;
    this.closeSuggestions();
    const surface = this.querySelector<HTMLElement>(".attendee-surface")!;
    const trigger = this.querySelector<HTMLButtonElement>(
      "[data-attendee-open]",
    )!;
    this.morph.run(surface, trigger, this.form, expanded, () => {
      this.toggleAttribute("data-expanded", expanded);
      trigger.setAttribute("aria-expanded", String(expanded));
      this.form.inert = !expanded;
      this.form.setAttribute("aria-hidden", String(!expanded));
      trigger.inert = expanded;
      (expanded ? this.form : trigger).focus({ preventScroll: true });
      if (expanded) {
        // Measure and scroll the expanded layout before the morph resizes it.
        const style = getComputedStyle(surface);
        const height =
          surface.getBoundingClientRect().height +
          parseFloat(style.scrollMarginTop) +
          parseFloat(style.scrollMarginBottom);
        surface.scrollIntoView({
          block: height > window.innerHeight ? "start" : "nearest",
          behavior: "instant",
        });
      }
    });
    if (!expanded)
      this.dispatchEvent(new Event("add-attendee-close", { bubbles: true }));
  }
}

if (!customElements.get("add-attendee"))
  customElements.define("add-attendee", AddAttendee);
