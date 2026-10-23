import { useState } from "react";
import { emailPreviews, type EmailPreview } from "../email-previews/catalog";
import "../styles/email-previews.css";

const groups = [...new Set(emailPreviews.map((email) => email.group))];
const exampleCount = emailPreviews.reduce(
  (total, email) => total + email.examples.length,
  0,
);

function previewDocument(html: string) {
  // Isolate email styling and disable network resources and links in the preview.
  // This wrapper is docs-only; the production HTML remains untouched.
  return html
    .replace(
      "<head>",
      `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
    <style>a { pointer-events: none; }</style>`,
    )
    .replaceAll("<a ", '<a tabindex="-1" aria-disabled="true" ');
}

function EmailDetail({ email }: { email: EmailPreview }) {
  const [exampleIndex, setExampleIndex] = useState(0);
  const [view, setView] = useState<"html" | "text" | "source">("html");
  const [narrow, setNarrow] = useState(false);
  const example = email.examples[exampleIndex];
  const activeView = example.html ? view : "text";

  return (
    <section
      className="email-detail"
      id="email-preview"
      aria-labelledby="email-preview-title"
    >
      <h2 id="email-preview-title">{email.name}</h2>
      <p className="email-trigger">{email.trigger}</p>
      {email.examples.length > 1 && (
        <label className="email-field">
          Example
          <select
            value={exampleIndex}
            onChange={(event) => setExampleIndex(Number(event.target.value))}
          >
            {email.examples.map((example, index) => (
              <option key={example.name} value={index}>
                {example.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="email-message">
        <dl className="email-envelope">
          <div>
            <dt>From</dt>
            <dd>{example.from}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>{example.to}</dd>
          </div>
          <div>
            <dt>Subject</dt>
            <dd>{example.subject}</dd>
          </div>
        </dl>
        <div className="email-toolbar">
          <div
            className="email-view-controls"
            role="group"
            aria-label="Message format"
          >
            {example.html && (
              <button
                type="button"
                aria-pressed={activeView === "html"}
                onClick={() => setView("html")}
              >
                Rendered HTML
              </button>
            )}
            <button
              type="button"
              aria-pressed={activeView === "text"}
              onClick={() => setView("text")}
            >
              Plain text
            </button>
            {example.html && (
              <button
                type="button"
                aria-pressed={activeView === "source"}
                onClick={() => setView("source")}
              >
                HTML source
              </button>
            )}
          </div>
          {activeView === "html" && (
            <div
              className="email-view-controls"
              role="group"
              aria-label="Preview width"
            >
              <button
                type="button"
                aria-pressed={!narrow}
                onClick={() => setNarrow(false)}
              >
                Desktop
              </button>
              <button
                type="button"
                aria-pressed={narrow}
                onClick={() => setNarrow(true)}
              >
                Mobile
              </button>
            </div>
          )}
        </div>
        {activeView === "html" && example.html ? (
          <div className="email-html-stage">
            <iframe
              className={narrow ? "email-html email-html-narrow" : "email-html"}
              title={`${email.name} HTML preview`}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={previewDocument(example.html)}
            />
          </div>
        ) : activeView === "source" ? (
          <pre className="email-source" tabIndex={0} aria-label="HTML source">
            <code>{example.html}</code>
          </pre>
        ) : (
          <pre className="email-text">{example.text}</pre>
        )}
      </div>
      <p className="email-muted">
        {example.html
          ? "Browser preview only; email apps may render HTML differently. Preview links are inactive."
          : "This email is sent as plain text. No HTML version is generated."}
      </p>
      <details className="email-delivery">
        <summary>Delivery and source</summary>
        <p>{email.delivery}</p>
        <p>
          Delivery workflow: <code>{email.source}</code>
        </p>
        <p>
          Shared message formatting: <code>src/data/email-templates.ts</code>
        </p>
      </details>
    </section>
  );
}

export default function EmailPreviews() {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [selectedId, setSelectedId] = useState(emailPreviews[0].id);
  const search = query.trim().toLowerCase();
  const visible = emailPreviews.filter(
    (email) =>
      (!group || email.group === group) &&
      (!search ||
        [
          email.name,
          email.group,
          email.trigger,
          ...email.examples.flatMap((example) => [
            example.name,
            example.subject,
            example.text,
          ]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search)),
  );
  const selected =
    visible.find((email) => email.id === selectedId) ?? visible[0];

  return (
    <div className="email-previews not-content">
      <div className="email-filters">
        <label className="email-field">
          Search emails
          <input
            type="search"
            placeholder="Find a subject, message or workflow"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="email-field">
          Category
          <select
            value={group}
            onChange={(event) => setGroup(event.target.value)}
          >
            <option value="">All categories</option>
            {groups.map((group) => (
              <option key={group}>{group}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="email-count" role="status">
        {visible.length} of {emailPreviews.length} email types · {exampleCount}{" "}
        examples in total
      </p>
      {selected ? (
        <div className="email-workspace">
          <nav className="email-list" aria-label="Email types">
            {groups
              .filter((group) => visible.some((email) => email.group === group))
              .map((group) => (
                <div className="email-list-group" key={group}>
                  <h2>{group}</h2>
                  <ul>
                    {visible
                      .filter((email) => email.group === group)
                      .map((email) => (
                        <li key={email.id}>
                          <button
                            type="button"
                            aria-pressed={selected.id === email.id}
                            aria-controls="email-preview"
                            onClick={() => setSelectedId(email.id)}
                          >
                            {email.name}
                          </button>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
          </nav>
          <EmailDetail key={selected.id} email={selected} />
        </div>
      ) : (
        <div className="email-empty">
          <h2>No matching emails</h2>
          <p>Try a different search or category.</p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setGroup("");
            }}
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
