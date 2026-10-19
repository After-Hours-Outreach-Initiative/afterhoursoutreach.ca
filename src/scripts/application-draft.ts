import {
  applicationDraftAnswersSchema,
  applicationDraftSchema,
  applicationDraftReadResponseSchema,
  applicationDraftSaveResponseSchema,
  applicationDraftDiscardSchema,
  applicationDraftDiscardResponseSchema,
  applicationDraftDiscardPrefix,
  localDraftDiscardSchema,
  applicationDraftStoragePrefix,
  localApplicationDraftSchema,
  sameDraftAnswers,
  type ApplicationDraft,
  type ApplicationDraftAnswers,
} from "../data/application-draft";
import { restoreBirthDate, syncBirthDate } from "./birth-date";

const endpoint = "/api/v1/account/application-draft";
const emptyAnswers = () => applicationDraftAnswersSchema.parse({});
const storageKey = (userId: string) =>
  `${applicationDraftStoragePrefix}${userId}`;

class DiscardError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function checkDiscardResponse(response: Response) {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403)
    throw new DiscardError(
      "Sign in to the same account, then retry discarding.",
    );
  if (response.status === 409 || response.status === 410)
    throw new DiscardError(
      "Reload to check your account before discarding again. A submitted application is never changed.",
    );
  throw new DiscardError(
    "Retry discarding when your connection is available.",
    response.status >= 500 || [408, 429].includes(response.status),
  );
}

async function confirmAccountDiscard(
  request: ReturnType<typeof applicationDraftDiscardSchema.parse>,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      });
      checkDiscardResponse(response);
      const result = applicationDraftDiscardResponseSchema.parse(
        await response.json(),
      );
      if (
        result.userId !== request.userId ||
        result.generation !== request.discardId
      )
        throw new DiscardError(
          "Your account changed. Reload to check before continuing.",
        );
      return;
    } catch (error) {
      if (error instanceof DiscardError && !error.retryable) throw error;
      // A lost response is not a failed deletion. Check the server without
      // restoring answers or accepting an empty draft from an older generation.
      try {
        const response = await fetch(endpoint, {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        checkDiscardResponse(response);
        const state = applicationDraftReadResponseSchema.parse(
          await response.json(),
        );
        if (state.userId !== request.userId)
          throw new DiscardError(
            "Your account changed. Reload to check before continuing.",
          );
        if (state.submitted)
          throw new DiscardError(
            "Reload to check your account before discarding again. A submitted application is never changed.",
          );
        if (state.generation === request.discardId && !state.draft) return;
        if (state.generation !== request.generation)
          throw new DiscardError(
            "Reload to check your account before discarding again. Your draft changed.",
          );
      } catch (verificationError) {
        if (
          verificationError instanceof DiscardError &&
          !verificationError.retryable
        )
          throw verificationError;
        // Verification can fail too; retry the same idempotent DELETE below.
      }
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

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
  const birthDate = syncBirthDate(element);
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
  if (birthDate !== undefined) answers.birthDate = birthDate;
  return answers;
}

export function initApplicationDraft(element: HTMLFormElement) {
  const userId = element.dataset.profileUserId;
  if (!userId || !element.hasAttribute("data-application")) return;
  const flow = element.closest("[data-application-flow]")!;
  const saveIndicator = flow.querySelector<HTMLElement>(
    "[data-draft-save-indicator]",
  )!;
  const saveMessageElement = saveIndicator.querySelector<HTMLElement>(
    "[data-draft-save-message]",
  )!;
  const saveTimeFormat = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const saveDateFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  });
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
  const generation: string | null = JSON.parse(
    element.dataset.draftGeneration ?? "null",
  );
  const discardKey = `${applicationDraftDiscardPrefix}${userId}`;
  const discardActions = flow.querySelector<HTMLElement>(
    "[data-application-draft-actions]",
  )!;
  const discardButton = discardActions.querySelector<HTMLButtonElement>(
    "[data-draft-discard]",
  )!;
  const discardLabel = discardButton.querySelector<HTMLElement>(
    "[data-draft-discard-label]",
  )!;
  const discardStatus = discardActions.querySelector<HTMLElement>(
    "[data-draft-discard-status]",
  )!;
  const newDraft =
    discardActions.querySelector<HTMLElement>("[data-draft-new]")!;
  discardButton.disabled = false;
  const readDiscard = () => {
    try {
      const parsed = localDraftDiscardSchema.safeParse(
        JSON.parse(localStorage.getItem(discardKey) ?? "null"),
      );
      return parsed.success && parsed.data.userId === userId
        ? parsed.data
        : undefined;
    } catch {
      return undefined;
    }
  };
  const initialDiscard = readDiscard();
  // A newer server generation (or deliberately authored post-discard draft)
  // supersedes an old failed retry. Do not trap this account in a retry loop or
  // let that retry delete newer answers; local generation checks still apply.
  const supersededDiscard =
    initialDiscard &&
    generation !== initialDiscard.generation &&
    (generation !== initialDiscard.discardId || Boolean(initial));
  const acceptedDiscardId =
    initialDiscard &&
    ((initialDiscard.completed && initialDiscard.discardId === generation) ||
      supersededDiscard)
      ? initialDiscard.discardId
      : undefined;
  let discardRequest:
    ReturnType<typeof applicationDraftDiscardSchema.parse> | undefined;
  let deleting = false;
  let accountDiscarded = false;
  let retryDiscardOnReconnect = false;
  let revision = initial?.revision ?? null;
  let savedAnswers = initial?.answers ?? emptyAnswers();
  let savedAt = initial?.updatedAt ?? null;
  let conflict: { draft: ApplicationDraft | null } | undefined;
  let inFlight: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dateTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (stopped || checkDiscard()) return;
    try {
      localStorage.setItem(
        storageKey(userId),
        JSON.stringify({
          version: 1,
          revision,
          generation,
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
    clearTimeout(dateTimer);
    dateTimer = undefined;
    const unsaved = dirty();
    conflictPanel.hidden = !conflict;
    retry.hidden = !failure || Boolean(conflict) || stopped;
    const backupWarning =
      !localAvailable && unsaved
        ? "Browser backup is unavailable. Keep this page open until your answers reach your account."
        : "";
    const message = [failure, backupWarning].filter(Boolean).join(" ");
    status.textContent = message;
    status.hidden = !message;
    statusPanel.hidden = !message && !conflict;

    let saveState = "idle";
    let saveMessage = "";
    if (stopped || paused) {
      saveState = "paused";
      saveMessage = "Saving paused";
    } else if (conflict) {
      saveState = "error";
      saveMessage = "Choose which answers to keep";
    } else if (failure || blocked) {
      saveState = "error";
      saveMessage = unsaved
        ? "Couldn’t save to your account"
        : "Couldn’t check save status";
    } else if (revision && savedAt !== null) {
      saveState = "saved";
      const savedDate = new Date(savedAt);
      const now = new Date();
      const date =
        savedDate.toDateString() === now.toDateString()
          ? ""
          : ` on ${saveDateFormat.format(savedDate)}`;
      saveMessage = `Last saved${date} at ${saveTimeFormat.format(savedDate)}`;
      // Refresh at local midnight without a ticking counter.
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      dateTimer = setTimeout(renderStatus, midnight.getTime() - now.getTime());
    } else if (inFlight || unsaved) {
      saveState = "pending";
      saveMessage = "";
    }
    saveIndicator.dataset.saveState = saveState;
    if (saveMessageElement.textContent !== saveMessage)
      saveMessageElement.textContent = saveMessage;
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
    // Repopulate the unnamed date parts before synthetic input/change listeners
    // can read them, including silent startup reconciliation.
    restoreBirthDate(element, answers.birthDate);
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
    if (!conflict) savedAt = remote?.updatedAt ?? null;
    persist();
    renderStatus();
  };
  const schedule = (delay = 1000) => {
    cancelTimer();
    if (!paused && !stopped && !blocked && !conflict && dirty())
      timer = setTimeout(() => void save(), delay);
  };
  const stopForDiscard = (message: string, notify = true) => {
    stopped = true;
    cancelTimer();
    conflict = undefined;
    failure = "";
    lastAttempt = undefined;
    savedAnswers = emptyAnswers();
    savedAt = null;
    restore(emptyAnswers(), notify);
    element.dataset.applicationDraft = "null";
    for (const answer of element.querySelectorAll<HTMLElement>(
      "[data-review-answer]",
    ))
      if (answer.dataset.reviewAnswer !== "email")
        answer.textContent = "Not provided";
    // Native form reset must not recover the server-rendered draft either.
    for (const control of element.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >("input, textarea")) {
      control.defaultValue = control.value;
      if (control instanceof HTMLInputElement)
        control.defaultChecked = control.checked;
    }
    // Freeze this page; starting over requires a fresh server generation.
    for (const fieldset of element.querySelectorAll<HTMLFieldSetElement>(
      "fieldset",
    ))
      fieldset.disabled = true;
    for (const button of flow.querySelectorAll<HTMLButtonElement>(
      "[data-application-review]",
    ))
      button.disabled = true;
    discardStatus.textContent = message;
    discardStatus.hidden = !message;
    newDraft.hidden = !message;
    renderStatus();
  };
  const clearOldLocal = () => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(storageKey(userId)) ?? "null",
      );
      const local = localApplicationDraftSchema.safeParse(stored);
      if (!local.success || local.data.generation === generation)
        localStorage.removeItem(storageKey(userId));
    } catch {
      /* The discard UI reports storage failures on explicit retry. */
    }
  };
  const checkDiscard = () => {
    const marker = readDiscard();
    if (!marker || marker.discardId === acceptedDiscardId) return false;
    if (!stopped) {
      stopForDiscard(
        "A draft discard was requested in another tab. Saving is paused. Reload to check its result.",
      );
      discardButton.hidden = true;
      clearOldLocal();
    }
    return true;
  };
  const discard = async () => {
    if (deleting) return;
    if (!discardRequest) {
      // A submitted/in-progress submission must not race destructive UI work.
      if (paused || stopped) return;
      if (
        !confirm(
          "Are you sure you want to permanently delete your application progress? This can’t be undone.",
        )
      )
        return;
      discardRequest = {
        userId,
        generation,
        discardId: discardActions.dataset.draftDiscardId!,
      };
    }
    deleting = true;
    retryDiscardOnReconnect = false;
    discardButton.disabled = true;
    discardLabel.textContent = "Discarding…";
    discardButton.setAttribute("aria-busy", "true");
    stopForDiscard("");
    let localCleared = false;
    try {
      // The answer-free marker also survives an offline reload and notifies tabs
      // before removing answers, so their pagehide handlers cannot restore them.
      localStorage.setItem(
        discardKey,
        JSON.stringify({ ...discardRequest, completed: accountDiscarded }),
      );
      localStorage.removeItem(storageKey(userId));
      localCleared = localStorage.getItem(storageKey(userId)) === null;
    } catch {
      /* Do not claim this device is clear if storage denied the write. */
    }
    let accountFailure = "";
    if (!accountDiscarded) {
      try {
        await confirmAccountDiscard(discardRequest);
        accountDiscarded = true;
      } catch (error) {
        retryDiscardOnReconnect =
          !(error instanceof DiscardError) || error.retryable;
        accountFailure =
          error instanceof Error && error.name === "Error"
            ? error.message
            : "Reconnect, then retry discarding.";
      }
    }
    if (accountDiscarded && localCleared) {
      try {
        localStorage.setItem(
          discardKey,
          JSON.stringify({ ...discardRequest, completed: true }),
        );
      } catch {
        localCleared = false;
      }
    }
    // A late save response must never restore memory or browser answers.
    clearOldLocal();
    if (accountDiscarded && localCleared) {
      location.replace("/apply");
      return;
    }
    discardStatus.textContent = `${localCleared ? "This browser’s draft answers were deleted." : "We could not confirm deletion of this browser’s copy. Clear this site’s browser data if retrying does not work."} ${accountDiscarded ? "Your account draft was deleted." : `Account draft deletion is not confirmed; it may still be saved. ${accountFailure}`} Saving remains paused on this page.`;
    discardStatus.hidden = false;
    newDraft.hidden = false;
    discardLabel.textContent = "Retry discarding application draft";
    discardButton.removeAttribute("aria-busy");
    discardButton.hidden = false;
    discardButton.disabled = false;
    deleting = false;
  };
  discardButton.addEventListener("click", () => void discard());
  window.addEventListener("storage", (event) => {
    if (event.key === discardKey) checkDiscard();
    if (
      event.key === storageKey(userId) &&
      stopped &&
      discardStatus.textContent
    )
      clearOldLocal();
  });
  const finishSubmitted = () => {
    stopped = true;
    cancelTimer();
    clearApplicationDraft(userId);
    renderStatus();
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
    if (stopped || checkDiscard()) return;
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
    if (result.generation !== generation) {
      stopForDiscard(
        "Your draft was discarded on another tab or device. Old answers were cleared and saving is paused. Reload to start or check your draft.",
      );
      discardButton.hidden = true;
      clearOldLocal();
      return;
    }
    reconcile(applicationDraftSchema.nullable().parse(result.draft));
  };
  const refresh = () => {
    if (paused || stopped || checkDiscard() || inFlight || refreshing)
      return refreshing;
    refreshing = (async () => {
      try {
        await fetchRemote();
        failure = "";
        retryDelay = 2000;
      } catch (error) {
        if (stopped) return;
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
    if (checkDiscard()) return;
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
          body: JSON.stringify({
            userId,
            version: 1,
            revision,
            generation,
            answers,
          }),
          signal: AbortSignal.timeout(15_000),
          keepalive,
        });
        if (stopped || checkDiscard()) return;
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
        if (stopped || checkDiscard()) return;
        revision = draft.revision;
        savedAnswers = draft.answers;
        savedAt = draft.updatedAt;
        failure = "";
        retryDelay = 2000;
      } catch (error) {
        if (stopped) return;
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
    if (initialDiscard && initialDiscard.discardId !== acceptedDiscardId) {
      const { completed: _completed, ...request } = initialDiscard;
      discardRequest = request;
      accountDiscarded = initialDiscard.completed;
      stopForDiscard("", false);
      clearOldLocal();
    }
    const stored = localStorage.getItem(storageKey(userId));
    if (stored && !stopped) {
      const local = localApplicationDraftSchema.safeParse(JSON.parse(stored));
      if (local.success && local.data.generation === generation) {
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
      savedAt = conflict.draft?.updatedAt ?? null;
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
      savedAt = remote?.updatedAt ?? null;
      conflict = undefined;
      failure = "";
      persist();
      renderStatus();
    });
  const resumePendingWork = () => {
    if (discardRequest && retryDiscardOnReconnect) void discard();
    else void refresh();
  };
  window.addEventListener("online", resumePendingWork);
  window.addEventListener("focus", resumePendingWork);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resumePendingWork();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumePendingWork();
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
      if (discardRequest) {
        void discard();
        return;
      }
      persist();
      renderStatus();
      schedule();
    },
    async beforeSubmit() {
      if (stopped || checkDiscard())
        throw new Error(
          "This draft was discarded. Reload before starting a new application.",
        );
      paused = true;
      cancelTimer();
      renderStatus();
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
      renderStatus();
    },
    async beforeSignOut() {
      if (stopped) return true;
      await refreshing;
      await save();
      paused = true;
      cancelTimer();
      renderStatus();
      if (
        dirty() &&
        !confirm(
          "Your latest answers have not reached your account. Sign out anyway? Any available browser backup will stay on this device.",
        )
      ) {
        paused = false;
        renderStatus();
        schedule();
        return false;
      }
      return true;
    },
  };
}
