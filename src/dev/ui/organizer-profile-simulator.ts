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
  type ProfilePreviewOptions,
  type ProfileSimulationState,
} from "./organizer-profile-fixtures";

/** A fixture-only controller: never imports the live organizer action/polling script. */
function initializeProfileSimulator() {
  const host = document.querySelector<HTMLElement>(
    "[data-ui-organizer-preview]",
  );
  const content = host?.querySelector<HTMLElement>(
    "[data-profile-preview-content]",
  );
  if (!host || !content) return;
  const root = host;
  const reader = content;
  let options = readProfileOptions(new URLSearchParams(location.search));
  let current =
    readProfileState(new URLSearchParams(location.search)) ??
    profileSimulationState(createProfileFixture(options));
  let phase: string = options.phase;
  let busy = false;
  let modified = false;
  let revision = 0;
  let lastConfiguration = -1;
  let generation = 0;
  let pendingRender: AbortController | undefined;

  function report() {
    root.dataset.uiPhase = phase;
    if (window.parent === window) return;
    window.parent.postMessage(
      {
        channel: profileChannel,
        type: "state",
        query: profileQuery(options).toString(),
        revision,
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
    reader.removeAttribute("aria-busy");
    if (options.phase === "loading") {
      const loading = document.createElement("div");
      loading.className = "ui-profile-loading";
      loading.setAttribute("role", "status");
      const icon = document.createElement("span");
      icon.className = "ui-profile-loading-icon";
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = "Loading";
      loading.appendChild(icon);
      loading.appendChild(label);
      reader.replaceChildren(loading);
      reader.setAttribute("aria-busy", "true");
    } else if (options.phase === "load-error") {
      reader.textContent = "Volunteer profile is temporarily unavailable.";
    } else enableControls();
  }

  async function loadPreview(
    nextOptions: ProfilePreviewOptions,
    nextState?: ProfileSimulationState,
    signal?: AbortSignal,
  ) {
    const query = nextState
      ? profileStateQuery(nextOptions, nextState)
      : profileQuery(nextOptions);
    const response = await fetch(`${profilePreviewPath}?${query}`, {
      credentials: "omit",
      cache: "no-store",
      signal,
    });
    if (!response.ok)
      throw new Error("The fictional preview could not be refreshed.");
    const page = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    const content = page.querySelector<HTMLElement>(
      "[data-profile-preview-content]",
    );
    if (!content) throw new Error("The fictional profile is unavailable.");
    return { content: document.importNode(content, true), title: page.title };
  }

  async function configure(
    next: ProfilePreviewOptions,
    nextRevision: number,
    replace: boolean,
    resetScroll: boolean,
  ) {
    if (nextRevision < lastConfiguration) return;
    if (nextRevision === lastConfiguration) {
      if (!pendingRender) report();
      return;
    }
    lastConfiguration = nextRevision;
    const needsReplacement =
      replace ||
      next.scenario !== options.scenario ||
      next.content !== options.content ||
      next.phase !== options.phase;
    pendingRender?.abort();
    pendingRender = undefined;
    if (!needsReplacement) {
      options = next;
      revision = nextRevision;
      history.replaceState(
        null,
        "",
        `${profilePreviewPath}?${profileQuery(options)}`,
      );
      report();
      return;
    }
    generation++;
    for (const dialog of root.querySelectorAll<HTMLDialogElement>(
      "dialog[open]",
    ))
      dialog.close();
    const controller = new AbortController();
    pendingRender = controller;
    try {
      // Keep the current document and content painted until the replacement is ready.
      const replacement = await loadPreview(next, undefined, controller.signal);
      if (controller.signal.aborted || pendingRender !== controller) return;
      const position = {
        left: resetScroll ? 0 : scrollX,
        top: resetScroll ? 0 : scrollY,
      };
      const expanded =
        !resetScroll &&
        reader.querySelector<HTMLDetailsElement>(
          "[data-submitted-application] details",
        )?.open;
      const nextApplication =
        replacement.content.querySelector<HTMLDetailsElement>(
          "[data-submitted-application] details",
        );
      if (expanded && nextApplication) nextApplication.open = true;
      disposeVolunteerProfileContents(reader);
      reader.replaceChildren(...replacement.content.childNodes);
      options = next;
      revision = nextRevision;
      current = profileSimulationState(createProfileFixture(options));
      phase = options.phase;
      modified = false;
      busy = false;
      root.dataset.uiScenario = options.scenario;
      document.title = replacement.title;
      history.replaceState(
        null,
        "",
        `${profilePreviewPath}?${profileQuery(options)}`,
      );
      showLoadState();
      window.scrollTo({ ...position, behavior: "instant" });
      report();
    } catch {
      if (!controller.signal.aborted)
        window.parent.postMessage(
          {
            channel: profileChannel,
            type: "error",
            query: profileQuery(next).toString(),
            revision: nextRevision,
          },
          location.origin,
        );
    } finally {
      if (pendingRender === controller) pendingRender = undefined;
    }
  }

  async function refreshProfile(
    next: ProfileSimulationState,
    selector: string,
    actionGeneration: number,
  ) {
    // Re-render only fictional props through the same Astro view. This route never
    // loads authentication, private profiles, a database, or organizer APIs.
    const page = await loadPreview({ ...options, phase: "ready" }, next);
    if (actionGeneration !== generation) return false;
    const replacement = page.content.querySelector<HTMLElement>(
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
    disposeVolunteerProfileContents(profile);
    profile.replaceWith(document.importNode(replacement, true));
    current = next;
    modified = true;
    enableControls();
    reader.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    return true;
  }

  async function act(form: HTMLFormElement) {
    if (
      busy ||
      pendingRender ||
      options.phase !== "ready" ||
      !form.reportValidity()
    )
      return;
    const actionGeneration = generation;
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
        if (actionGeneration !== generation) return;
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
      if (actionGeneration !== generation) return;
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
      if (next.patrol !== current.patrol) next.patrolChangedAt = Date.now();
      if (!(await refreshProfile(next, selector, actionGeneration))) return;
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
      if (actionGeneration !== generation) return;
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
        if (actionGeneration === generation) busy = false;
      }
      if (actionGeneration === generation) report();
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
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.origin !== location.origin ||
      event.source !== window.parent ||
      event.data?.channel !== profileChannel ||
      event.data.type !== "configure" ||
      typeof event.data.query !== "string" ||
      !Number.isSafeInteger(event.data.revision) ||
      event.data.revision < 0
    )
      return;
    const next = readProfileOptions(new URLSearchParams(event.data.query));
    void configure(
      next,
      event.data.revision,
      event.data.replace === true,
      event.data.resetScroll === true,
    );
  });
  showLoadState();
  report();
}

if (import.meta.env.DEV) initializeProfileSimulator();
