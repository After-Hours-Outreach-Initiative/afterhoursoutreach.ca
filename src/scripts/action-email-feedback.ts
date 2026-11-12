import { createDialogHeader } from "./dialog";

export interface EmailActionResult {
  message?: string;
  retryOperation?: string;
  pending?: number;
  expired?: number;
  unconfirmed?: number;
  /** Set when the change waits for its undo timer instead of being made. */
  pendingAction?: import("./pending-actions").PendingAction;
}

export function actionEmailNeedsFeedback(result: EmailActionResult) {
  return Boolean(
    result.pending ||
    result.expired ||
    result.unconfirmed ||
    result.retryOperation,
  );
}

let nextResultId = 0;

/** An action-scoped result survives roster refreshes, even when cancellation
 * removes the original controls. Only this operation can be retried here. */
export function showActionEmailFeedback(
  title: string,
  endpoint: string,
  initial: EmailActionResult,
) {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog-pop dialog-frame volunteer-dialog";
  dialog.dataset.actionEmailFeedback = "";
  const heading = document.createElement("h2");
  heading.id = `action-email-result-${++nextResultId}`;
  heading.textContent = title;
  dialog.setAttribute("aria-labelledby", heading.id);
  const { header, close } = createDialogHeader(heading);
  const content = document.createElement("div");
  content.className = "dialog-body";
  const message = document.createElement("p");
  message.className = "volunteer-notice";
  message.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "dialog-footer";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-outline";
  retry.textContent = "Retry email only";
  let result = initial;
  const render = () => {
    message.textContent = result.message ?? "Change saved.";
    message.setAttribute(
      "role",
      result.retryOperation || result.expired ? "alert" : "status",
    );
    retry.hidden = !result.retryOperation;
    actions.hidden = !result.retryOperation;
  };
  render();
  retry.addEventListener("click", async () => {
    if (retry.disabled || !result.retryOperation) return;
    retry.disabled = true;
    close.disabled = true;
    retry.textContent = "Sending…";
    message.textContent = "Sending…";
    dialog.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "retry-notifications",
          operation: result.retryOperation,
        }),
      });
      const updated: EmailActionResult = await response.json();
      if (!response.ok)
        throw new Error(updated.message || "Email retry is unavailable.");
      result = updated;
      if (!actionEmailNeedsFeedback(result)) dialog.close();
    } catch (error) {
      result.message = `The change remains saved. ${error instanceof Error ? error.message : "Email delivery could not be confirmed."} Do not repeat the saved change.`;
    } finally {
      retry.disabled = false;
      close.disabled = false;
      retry.textContent = "Retry email only";
      dialog.removeAttribute("aria-busy");
      render();
    }
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (retry.disabled) event.preventDefault();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  actions.appendChild(retry);
  content.appendChild(message);
  for (const child of [header, content, actions]) dialog.appendChild(child);
  (document.querySelector(".volunteer-portal") ?? document.body).appendChild(
    dialog,
  );
  dialog.showModal();
}
