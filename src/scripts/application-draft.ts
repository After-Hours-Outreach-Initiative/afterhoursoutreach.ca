import {
  applicationDraftAnswersSchema,
  applicationDraftSchema,
  applicationDraftReadResponseSchema,
  applicationDraftSaveResponseSchema,
  applicationDraftStoragePrefix,
  localApplicationDraftSchema,
  sameDraftAnswers,
  type ApplicationDraft,
  type ApplicationDraftAnswers,
} from "../data/application-draft";

const endpoint = "/api/v1/account/application-draft";
const emptyAnswers = () => applicationDraftAnswersSchema.parse({});
const storageKey = (userId: string) =>
  `${applicationDraftStoragePrefix}${userId}`;

export function clearApplicationDraft(userId: string) {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // Storage can be disabled independently of network access.
  }
}

export function clearSyncedApplicationDrafts() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(applicationDraftStoragePrefix)) continue;
      let stored: unknown;
      try {
        stored = JSON.parse(localStorage.getItem(key) ?? "null");
      } catch {
        // One corrupted record must not stop cleanup of other account copies.
        continue;
      }
      const parsed = localApplicationDraftSchema.safeParse(stored);
      if (
        parsed.success &&
        sameDraftAnswers(parsed.data.answers, parsed.data.savedAnswers)
      )
        localStorage.removeItem(key);
    }
  } catch {
    // Signing out must still work when browser storage is unavailable.
  }
}

export function readDraftAnswers(element: HTMLFormElement) {
  const answers = emptyAnswers();
  for (const name of Object.keys(answers) as (keyof typeof answers)[]) {
    const controls = [
      ...element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        `[name="${name}"]`,
      ),
    ];
    if (Array.isArray(answers[name])) {
      Object.assign(answers, {
        [name]: controls
          .filter(
            (control) =>
              control instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(control.type) &&
              control.checked,
          )
          .map((control) => control.value),
      });
    } else Object.assign(answers, { [name]: controls[0]?.value ?? "" });
  }
  return answers;
}

export function initApplicationDraft(element: HTMLFormElement) {
  const userId = element.dataset.profileUserId;
  if (!userId || !element.hasAttribute("data-application")) return;
  const status = element.querySelector<HTMLElement>("[data-draft-status]")!;
  const statusPanel = element.querySelector<HTMLElement>(
    "[data-draft-status-panel]",
  )!;
  const retry = element.querySelector<HTMLButtonElement>("[data-draft-retry]")!;
  const conflictPanel = element.querySelector<HTMLElement>(
    "[data-draft-conflict]",
  )!;
  const initial = applicationDraftSchema
    .nullable()
    .parse(JSON.parse(element.dataset.applicationDraft ?? "null"));
  let revision = initial?.revision ?? null;
  let savedAnswers = initial?.answers ?? emptyAnswers();
  let conflict: { draft: ApplicationDraft | null } | undefined;
  let inFlight: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let stopped = false;
  let blocked = false;
  let restoring = false;
  let localAvailable = true;
  let failure = "";
  let retryDelay = 2000;
  let lastAttempt: ApplicationDraftAnswers | undefined;

  const dirty = () =>
    !sameDraftAnswers(readDraftAnswers(element), savedAnswers);
  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const persist = () => {
    if (stopped) return;
    try {
      localStorage.setItem(
        storageKey(userId),
        JSON.stringify({
          version: 1,
          revision,
          answers: readDraftAnswers(element),
          savedAnswers,
        }),
      );
      localAvailable = true;
    } catch {
      localAvailable = false;
    }
  };
  const renderStatus = () => {
    conflictPanel.hidden = !conflict;
    retry.hidden = !failure || Boolean(conflict) || stopped;
    const backupWarning =
      !localAvailable && dirty()
        ? "Browser backup is unavailable. Keep this page open until your answers reach your account."
        : "";
    const message = [failure, backupWarning].filter(Boolean).join(" ");
    status.textContent = message;
    status.hidden = !message;
    statusPanel.hidden = !message && !conflict;
  };
  const restore = (answers: ApplicationDraftAnswers, notify = true) => {
    restoring = true;
    for (const [name, value] of Object.entries(answers)) {
      for (const control of element.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >(`[name="${name}"]`)) {
        if (
          Array.isArray(value) &&
          control instanceof HTMLInputElement &&
          ["checkbox", "radio"].includes(control.type)
        )
          control.checked = value.includes(control.value);
        else if (typeof value === "string") control.value = value;
      }
    }
    const consent = element.querySelector<HTMLInputElement>(
      '[name="codeOfConductAccepted"]',
    );
    if (consent) consent.checked = false;
    if (notify) {
      // Re-run conditional visibility and validation, without recording consent.
      for (const control of element.querySelectorAll("input, textarea")) {
        control.dispatchEvent(new Event("change", { bubbles: true }));
        control.dispatchEvent(new Event("input", { bubbles: true }));
      }
      element.dispatchEvent(new Event("application-draft-restored"));
    }
    restoring = false;
  };
  const reconcile = (remote: ApplicationDraft | null, notify = true) => {
    const answers = readDraftAnswers(element);
    const remoteAnswers = remote?.answers ?? emptyAnswers();
    if (sameDraftAnswers(answers, remoteAnswers)) {
      revision = remote?.revision ?? null;
      savedAnswers = remoteAnswers;
      conflict = undefined;
    } else if (!dirty()) {
      restore(remoteAnswers, notify);
      revision = remote?.revision ?? null;
      savedAnswers = remoteAnswers;
      conflict = undefined;
    } else if (lastAttempt && sameDraftAnswers(remoteAnswers, lastAttempt)) {
      // The write succeeded but its response was lost; retain any newer edits.
      revision = remote?.revision ?? null;
      savedAnswers = remoteAnswers;
      conflict = undefined;
    } else if (revision !== (remote?.revision ?? null)) {
      conflict = { draft: remote };
      cancelTimer();
    }
    persist();
    renderStatus();
  };
  const schedule = (delay = 1000) => {
    cancelTimer();
    if (!paused && !stopped && !blocked && !conflict && dirty())
      timer = setTimeout(() => void save(), delay);
  };
  const finishSubmitted = () => {
    stopped = true;
    cancelTimer();
    clearApplicationDraft(userId);
  };
  const fetchRemote = async () => {
    const response = await fetch(endpoint, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Sign in again or retry saving.");
    const result = applicationDraftReadResponseSchema.parse(
      await response.json(),
    );
    if (result.userId !== userId) {
      blocked = true;
      throw new Error("Your account changed. Reload before continuing.");
    }
    if (result.submitted) {
      finishSubmitted();
      location.assign("/volunteer/account");
      return;
    }
    blocked = false;
    reconcile(applicationDraftSchema.nullable().parse(result.draft));
  };
  const refresh = () => {
    if (paused || stopped || inFlight || refreshing) return refreshing;
    refreshing = (async () => {
      try {
        await fetchRemote();
        failure = "";
        retryDelay = 2000;
      } catch (error) {
        failure =
          error instanceof Error
            ? error.message
            : "We could not connect. Retry saving.";
      } finally {
        refreshing = undefined;
        renderStatus();
        schedule();
      }
    })();
    return refreshing;
  };
  const save = (keepalive = false): Promise<void> | undefined => {
    if (inFlight) return inFlight;
    if (paused || stopped || blocked || conflict || refreshing || !dirty())
      return;
    cancelTimer();
    const answers = readDraftAnswers(element);
    lastAttempt = answers;
    inFlight = (async () => {
      let delay = 1000;
      try {
        const response = await fetch(endpoint, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, version: 1, revision, answers }),
          signal: AbortSignal.timeout(15_000),
          keepalive,
        });
        if (response.status === 409 || response.status === 410) {
          await fetchRemote();
          return;
        }
        if (!response.ok) {
          if (response.status === 429) delay = 60_000;
          if (response.status === 401 || response.status === 403) {
            blocked = true;
            throw new Error("Sign in again or reload to continue saving.");
          }
          throw new Error(
            "We could not save to your account. Retrying automatically.",
          );
        }
        const result = applicationDraftSaveResponseSchema.parse(
          await response.json(),
        );
        if (result.userId !== userId) {
          blocked = true;
          throw new Error("Your account changed. Reload before continuing.");
        }
        const draft = applicationDraftSchema.parse(result.draft);
        revision = draft.revision;
        savedAnswers = draft.answers;
        failure = "";
        retryDelay = 2000;
      } catch (error) {
        failure =
          error instanceof Error && error.name === "Error"
            ? error.message
            : "We could not connect. Retrying automatically.";
        delay = Math.max(delay, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      } finally {
        inFlight = undefined;
        persist();
        renderStatus();
        schedule(delay);
      }
    })();
    renderStatus();
    return inFlight;
  };

  try {
    const stored = localStorage.getItem(storageKey(userId));
    if (stored) {
      const local = localApplicationDraftSchema.safeParse(JSON.parse(stored));
      if (local.success) {
        revision = local.data.revision;
        savedAnswers = local.data.savedAnswers;
        restore(local.data.answers, false);
        reconcile(initial, false);
      }
    }
  } catch {
    // Corrupted drafts are ignored; network autosave still works.
  }

  const changed = () => {
    if (restoring || stopped) return;
    persist();
    renderStatus();
    schedule();
  };
  element.addEventListener("input", changed);
  element.addEventListener("change", changed);
  element.addEventListener("reset", () => {
    // Let native reset and the conditional-field reset handlers finish first.
    queueMicrotask(() => queueMicrotask(changed));
  });
  retry.addEventListener("click", () => void refresh());
  element
    .querySelector("[data-draft-keep-local]")
    ?.addEventListener("click", () => {
      if (!conflict) return;
      revision = conflict.draft?.revision ?? null;
      savedAnswers = conflict.draft?.answers ?? emptyAnswers();
      conflict = undefined;
      failure = "";
      persist();
      renderStatus();
      schedule(0);
    });
  element
    .querySelector("[data-draft-use-account]")
    ?.addEventListener("click", () => {
      if (!conflict) return;
      const remote = conflict.draft;
      restore(remote?.answers ?? emptyAnswers());
      revision = remote?.revision ?? null;
      savedAnswers = remote?.answers ?? emptyAnswers();
      conflict = undefined;
      failure = "";
      persist();
      renderStatus();
    });
  window.addEventListener("online", () => void refresh());
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
    else {
      persist();
      void save(true);
    }
  });
  window.addEventListener("pagehide", () => {
    persist();
    void save(true);
  });

  return {
    start() {
      persist();
      renderStatus();
      schedule();
    },
    async beforeSubmit() {
      paused = true;
      cancelTimer();
      await inFlight;
      await refreshing;
      if (conflict || stopped || blocked)
        throw new Error(
          conflict
            ? "Choose which draft answers to keep before submitting."
            : failure || "Reload before submitting your application.",
        );
      // A remote refresh may have replaced answers while submission waited for
      // an autosave. Never reuse consent captured before that replacement.
      if (
        !element.querySelector<HTMLInputElement>(
          '[name="codeOfConductAccepted"]',
        )?.checked
      )
        throw new Error(
          "Review your answers and accept the Code of Conduct before submitting.",
        );
    },
    resume() {
      paused = false;
      renderStatus();
      schedule();
    },
    submitted: finishSubmitted,
    signedOut() {
      stopped = true;
      cancelTimer();
    },
    async beforeSignOut() {
      await refreshing;
      await save();
      paused = true;
      cancelTimer();
      if (
        dirty() &&
        !confirm(
          "Your latest answers have not reached your account. Sign out anyway? Any available browser backup will stay on this device.",
        )
      ) {
        paused = false;
        schedule();
        return false;
      }
      return true;
    },
  };
}
