// Imported by the real account/event UI through DEV-gated dynamic imports.
import "../styles/local-email-dialog.css";

let nextDialogId = 0;

export interface LocalEmail {
  to: string;
  subject: string;
  body: string;
  href?: string;
}

export function localEmailDialog(options: {
  title?: string;
  description?: string;
  emails?: LocalEmail[];
  actions: { value: string; label: string }[];
}): Promise<string | null> {
  if (!import.meta.env.DEV)
    throw new Error("Email simulation is local-development only.");
  const dialog = document.createElement("dialog");
  dialog.className = "dialog-pop local-email-dialog";
  const heading = document.createElement("h2");
  // This is only an accessible DOM label, not a security token. Use a counter
  // so development over HTTP LAN addresses doesn't need secure-context crypto.
  heading.id = `local-email-${++nextDialogId}`;
  heading.textContent = options.title ?? "Test email outcome";
  dialog.setAttribute("aria-labelledby", heading.id);
  const warning = document.createElement("p");
  warning.textContent = "Local test only. No real emails are sent.";
  dialog.appendChild(heading);
  dialog.appendChild(warning);
  if (options.description) {
    const description = document.createElement("p");
    description.textContent = options.description;
    dialog.appendChild(description);
  }
  for (const email of options.emails ?? []) {
    const article = document.createElement("article");
    const subject = document.createElement("h3");
    subject.textContent = email.subject;
    const address = document.createElement("p");
    address.textContent = `To: ${email.to}`;
    const body = document.createElement("p");
    body.className = "local-email-body";
    body.textContent = email.body;
    article.appendChild(subject);
    article.appendChild(address);
    article.appendChild(body);
    if (email.href) {
      const url = new URL(email.href, location.origin);
      if (url.origin === location.origin) {
        const link = document.createElement("a");
        link.className = "btn btn-outline";
        link.href = url.href;
        link.textContent = "Open local sign-in link";
        article.appendChild(link);
      }
    }
    dialog.appendChild(article);
  }
  const actions = document.createElement("div");
  actions.className = "local-email-actions";
  for (const action of options.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-outline";
    button.textContent = action.label;
    button.addEventListener("click", () => dialog.close(action.value));
    actions.appendChild(button);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-quiet";
  close.textContent = "Close email test";
  close.addEventListener("click", () => dialog.close());
  actions.appendChild(close);
  dialog.appendChild(actions);
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const result = dialog.returnValue || null;
        dialog.remove();
        resolve(result);
      },
      { once: true },
    );
    dialog.showModal();
  });
}

export function chooseEmailOutcome(
  emails?: LocalEmail[],
  notification = false,
) {
  return localEmailDialog({
    emails,
    description: notification
      ? "The change is already saved locally. Choose how its email notification turns out."
      : "Choose the result of requesting a sign-in email.",
    actions: [
      { value: "success", label: "Simulate successful delivery" },
      { value: "failure", label: "Simulate delivery failure" },
      ...(!notification
        ? [{ value: "rate-limited", label: "Simulate rate limit" }]
        : []),
    ],
  });
}
