import { chooseNotification } from "../../scripts/notification-choice";
import { showActionEmailFeedback } from "../../scripts/action-email-feedback";
import {
  disposeVolunteerProfileContents,
  initVolunteerProfileContents,
} from "../../scripts/volunteer-profile-contents";
import {
  createProfileFixture,
  profileChannel,
  profilePreviewPath,
  profileQuery,
  profileSimulationState,
  profileStateQuery,
  readProfileOptions,
  readProfileState,
  type ProfileSimulationState,
} from "./organizer-profile-fixtures";

/** A fixture-only controller: never imports the live organizer action/polling script. */
function initializeProfileSimulator() {
  const host = document.querySelector<HTMLElement>(
    "[data-ui-organizer-preview]",
  );
  const content = host?.querySelector<HTMLElement>(
    "[data-profile-dialog-content], [data-profile-preview-content]",
  );
  if (!host || !content) return;
  const root = host;
  const reader = content;
  const dialog = root.querySelector<HTMLDialogElement>(
    "[data-volunteer-profile-dialog]",
  );
  let options = readProfileOptions(new URLSearchParams(location.search));
  let current =
    readProfileState(new URLSearchParams(location.search)) ??
    profileSimulationState(createProfileFixture(options));
  let phase: string = options.phase;
  let busy = false;
  let modified = false;

  function report() {
    root.dataset.uiPhase = phase;
    if (window.parent === window) return;
    window.parent.postMessage(
      {
        channel: profileChannel,
        type: "state",
        query: profileQuery(options).toString(),
        phase,
        modified,
        state: {
          ...options,
          ...current,
          phase,
          modified,
          fixture: createProfileFixture(options, current),
        },
      },
      location.origin,
    );
  }
  function enableControls() {
    for (const control of reader.querySelectorAll<
      HTMLElement & { disabled: boolean }
    >("[data-volunteer-control]"))
      control.disabled = false;
    initVolunteerProfileContents(reader);
  }
  function showLoadState() {
    if (options.phase === "loading") {
      const template = root.querySelector<HTMLTemplateElement>(
        "[data-profile-dialog-loading]",
      );
      if (template) reader.replaceChildren(template.content.cloneNode(true));
      else {
        const loading = document.createElement("div");
        loading.className = "volunteer-profile-loading";
        loading.setAttribute("role", "status");
        const icon = document.createElement("span");
        icon.className = "volunteer-profile-loading-icon";
        icon.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = "Loading";
        loading.appendChild(icon);
        loading.appendChild(label);
        reader.replaceChildren(loading);
      }
      reader.setAttribute("aria-busy", "true");
    } else if (options.phase === "load-error") {
      reader.textContent =
        "Could not load the profile. Check your organizer session and try again.";
    } else enableControls();
  }

  async function refreshProfile(
    next: ProfileSimulationState,
    selector: string,
  ) {
    // Re-render only fictional props through the same Astro view. This route never
    // loads authentication, private profiles, a database, or organizer APIs.
    const response = await fetch(
      `${profilePreviewPath}?${profileStateQuery({ ...options, phase: "ready" }, next)}`,
      { credentials: "omit", cache: "no-store" },
    );
    if (!response.ok)
      throw new Error(
        "The fictional preview could not be refreshed. Reset the preview to try again.",
      );
    const page = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    const replacement = page.querySelector<HTMLElement>(
      "[data-volunteer-profile]",
    );
    if (!replacement) throw new Error("The fictional profile is unavailable.");
    const profile = reader.querySelector<HTMLElement>(
      "[data-volunteer-profile]",
    )!;
    const expanded = profile.querySelector<HTMLDetailsElement>(
      "[data-submitted-application] details",
    )?.open;
    const nextApplication = replacement.querySelector<HTMLDetailsElement>(
      "[data-submitted-application] details",
    );
    if (expanded && nextApplication) nextApplication.open = true;
    const scroll = reader.scrollTop;
    disposeVolunteerProfileContents(profile);
    profile.replaceWith(document.importNode(replacement, true));
    current = next;
    modified = true;
    enableControls();
    reader.scrollTop = scroll;
    reader.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }

  async function act(form: HTMLFormElement) {
    if (busy || options.phase !== "ready" || !form.reportValidity()) return;
    busy = true;
    const values = new FormData(form);
    const profile = form.closest<HTMLElement>("[data-volunteer-profile]")!;
    form.dataset.submitting = "true";
    profile.dataset.submitting = "true";
    const controls = [
      ...profile.querySelectorAll<HTMLElement & { disabled: boolean }>(
        'input:not([type="hidden"]), select, textarea, button',
      ),
    ].filter((control) => !control.disabled);
    controls.forEach((control) => (control.disabled = true));
    const button = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    const label = button?.textContent ?? "";
    const loading = form.querySelector<HTMLElement>("[data-action-loading]");
    const message = form.querySelector<HTMLElement>("[data-form-message]");
    if (message) {
      message.hidden = true;
      message.textContent = "";
    }
    let paused = false;
    try {
      let notify = form.hasAttribute("data-organizer-rejection");
      if (form.dataset.emailPrompt) {
        phase = "choosing-notification";
        report();
        const choice = await chooseNotification(form.dataset.emailPrompt);
        if (choice === null) {
          form.reset();
          phase = "cancelled";
          return;
        }
        notify = choice;
      }
      phase = "saving";
      form.setAttribute("aria-busy", "true");
      if (button)
        button.textContent = notify
          ? "Sending…"
          : (button.dataset.loadingLabel ?? label);
      if (loading) {
        loading.hidden = false;
        loading.textContent = notify ? "Sending…" : "Saving…";
      }
      if (notify && message) {
        message.hidden = false;
        message.textContent = "Sending…";
        message.setAttribute("role", "status");
      }
      report();
      const outcome = options.outcome;
      if (outcome === "pending") {
        paused = true;
        return;
      }
      await new Promise((resolve) =>
        window.setTimeout(resolve, options.latency),
      );
      if (outcome === "failure")
        throw new Error("The change could not be saved. Please try again.");
      if (outcome === "conflict")
        throw new Error(
          "This volunteer's status changed. Reload before saving.",
        );
      const next = { ...current };
      let selector =
        '[data-organizer-status][data-access-kind="application"] button';
      if (form.hasAttribute("data-organizer-role")) {
        next.role =
          values.get("role") === "organizer" ? "organizer" : "volunteer";
        selector = "[data-organizer-role] select";
      } else if (form.hasAttribute("data-organizer-rejection")) {
        next.rejection = String(values.get("reason") ?? "").trim();
      } else if (values.has("approvePatrols")) {
        next.patrol = true;
        selector = '[data-organizer-status][data-access-kind="patrol"] button';
      } else {
        next.approved = values.has("applicationApproved");
        next.patrol = next.approved && values.has("patrolApproved");
        next.active = values.has("active");
        if (next.approved) next.rejection = null;
        if (form.dataset.accessKind === "active")
          selector =
            '[data-organizer-status][data-access-kind="active"] input[name="active"]';
        else if (form.dataset.accessKind === "patrol")
          selector =
            '[data-organizer-status][data-access-kind="patrol"] button';
      }
      if (
        next.approved &&
        createProfileFixture(options).progress.naloxoneCompletedAt === null
      )
        throw new Error(
          "The applicant must complete Naloxone 101 before approval.",
        );
      await refreshProfile(next, selector);
      phase =
        outcome === "email-failure" && notify ? "saved-email-failed" : "saved";
      if (phase === "saved-email-failed")
        showActionEmailFeedback(
          form.hasAttribute("data-organizer-rejection")
            ? "Application rejected"
            : form.hasAttribute("data-organizer-role")
              ? "Account role saved"
              : "Volunteer access saved",
          profilePreviewPath,
          {
            message:
              "The change is saved, but email delivery could not be confirmed. No real email was sent.",
          },
        );
    } catch (error) {
      phase = "save-error";
      if (form.hasAttribute("data-submit-on-change")) form.reset();
      if (message) {
        message.textContent =
          error instanceof Error
            ? error.message
            : "The change could not be saved.";
        message.dataset.messageKind = "error";
        message.setAttribute("role", "alert");
        message.hidden = false;
        message.scrollIntoView({ block: "nearest" });
      }
    } finally {
      if (!paused) {
        controls.forEach((control) => (control.disabled = false));
        if (button) button.textContent = label;
        if (loading) loading.hidden = true;
        form.removeAttribute("aria-busy");
        delete form.dataset.submitting;
        delete profile.dataset.submitting;
        busy = false;
      }
      report();
    }
  }

  // Bind before enabling any real form controls. No form can reach an API.
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target instanceof HTMLFormElement) void act(event.target);
  });
  root.addEventListener("change", (event) => {
    if (event.target instanceof Element)
      event.target
        .closest<HTMLFormElement>("form[data-submit-on-change]")
        ?.requestSubmit();
  });
  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    event.target
      .closest("[data-dismiss-dialog]")
      ?.closest<HTMLDialogElement>("dialog")
      ?.close();
    if (
      event.target.closest("[data-ui-profile-reopen]") &&
      dialog &&
      !dialog.open
    ) {
      dialog.showModal();
      phase = options.phase;
      report();
    }
    if (event.target instanceof HTMLDialogElement) {
      const bounds = event.target.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        event.target.close();
    }
  });
  dialog?.addEventListener("close", () => {
    phase = "closed";
    report();
  });
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.origin !== location.origin ||
      event.source !== window.parent ||
      event.data?.channel !== profileChannel ||
      event.data.type !== "configure" ||
      typeof event.data.query !== "string"
    )
      return;
    const next = readProfileOptions(new URLSearchParams(event.data.query));
    if (
      next.scenario !== options.scenario ||
      next.surface !== options.surface ||
      next.content !== options.content ||
      next.phase !== options.phase
    )
      return;
    options = next;
    report();
  });
  showLoadState();
  dialog?.showModal();
  report();
}

if (import.meta.env.DEV) initializeProfileSimulator();
