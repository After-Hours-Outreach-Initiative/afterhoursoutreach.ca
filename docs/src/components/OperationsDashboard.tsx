import { useEffect, useRef, useState } from "react";
import type {
  ActionInput,
  AuditEntry,
  Database,
  Inspection,
  Overview,
  Plan,
  Row,
  User,
} from "../dashboard/types";

const endpoint = "/__docs/dashboard/";
const date = (value: unknown) =>
  value
    ? new Date(
        typeof value === "number" ? value : String(value),
      ).toLocaleString()
    : "—";
const number = (value: unknown) =>
  typeof value === "number" ? value.toLocaleString() : String(value ?? "—");
const title = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Could not load this section.";
type Section =
  "overview" | "users" | "events" | "email" | "health" | "activity";
interface ApiOptions {
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}
type Api = <T>(route: string, options?: ApiOptions) => Promise<T>;
interface ResendUsage {
  configured: boolean;
  loadedAt?: number;
  usage?: {
    emails?: { daily?: Quota; monthly?: Quota };
    rate_limit?: { limit: number; duration: string };
    contacts?: Quota;
    domains?: Quota;
  };
  rateLimitRemaining?: string | null;
}
interface Quota {
  used: number;
  limit: number | null;
  resets_at?: string;
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function RowTable({
  rows,
  empty = "No records.",
  columns,
}: {
  rows: Row[];
  empty?: string;
  columns?: string[];
}) {
  if (!rows.length) return <p className="ops-muted">{empty}</p>;
  const keys = columns ?? Object.keys(rows[0]);
  return (
    <div
      className="ops-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Scrollable records"
    >
      <table>
        <thead>
          <tr>
            {keys.map((key) => (
              <th key={key}>{title(key)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {keys.map((key) => (
                <td key={key}>
                  {/(_at|At|Until)$/.test(key)
                    ? date(row[key])
                    : number(row[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Stats({ counts }: { counts: Row }) {
  const labels = {
    users: "Users",
    pending: "Awaiting approval",
    organizers: "Organizers",
    active: "Active users",
    upcomingEvents: "Upcoming events",
    registrations: "Upcoming registrations",
  };
  return (
    <dl className="ops-stats">
      {Object.entries(labels).map(([key, label]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{number(counts[key] ?? 0)}</dd>
        </div>
      ))}
    </dl>
  );
}
function ReviewDialog({
  plan,
  onCancel,
  onApply,
  busy,
  error,
}: {
  plan: Plan;
  onCancel: () => void;
  onApply: (confirmation: string) => void;
  busy: boolean;
  error: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      className="ops-dialog"
      ref={dialog}
      aria-labelledby="ops-review-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onCancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onApply(confirmation);
        }}
      >
        <h2 id="ops-review-title">{plan.title}</h2>
        {plan.details.map((detail, index) => (
          <p key={index}>{detail}</p>
        ))}
        {plan.impact.length > 0 && (
          <div>
            <h3>Affected records</h3>
            <dl className="ops-impact">
              {plan.impact.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.count}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {plan.blocked.length > 0 && (
          <div className="ops-notice ops-danger" role="alert">
            <strong>This change is blocked</strong>
            <ul>
              {plan.blocked.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {plan.confirmation && !plan.blocked.length && (
          <label>
            Type <strong>{plan.confirmation}</strong> to confirm
            <input
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
              autoFocus
            />
          </label>
        )}
        <p className="ops-muted">
          This review expires at {date(plan.expiresAt)}. Data and database
          safety rules are checked again before the change.
        </p>
        {error && (
          <p className="ops-notice ops-danger" role="alert">
            {error}
          </p>
        )}
        <div className="ops-buttons">
          <button type="button" onClick={onCancel} disabled={busy}>
            Close
          </button>
          <button
            className={
              plan.confirmation ? "ops-button-danger" : "ops-button-primary"
            }
            type="submit"
            disabled={
              busy ||
              Boolean(error) ||
              !!plan.blocked.length ||
              confirmation !== plan.confirmation
            }
          >
            {busy ? "Applying…" : "Apply change"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Users({
  api,
  database,
  refresh,
  canWrite,
  prepare,
}: {
  api: Api;
  database: string;
  refresh: number;
  canWrite: boolean;
  prepare: (input: ActionInput) => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ users: User[]; hasMore: boolean }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setData(undefined);
    void api<{ users: User[]; hasMore: boolean }>("users", {
      query: { database, search: query, filter, offset: String(offset) },
      signal: controller.signal,
    })
      .then(setData)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [api, database, refresh, query, filter, offset]);
  const access = (
    user: User,
    field: "active" | "applicationApproved" | "patrolApproved",
  ) => prepare({ action: "access", id: user.id, field, value: !user[field] });
  return (
    <section aria-labelledby="ops-users-heading">
      <h2 id="ops-users-heading">Users and approvals</h2>
      <form
        className="ops-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search);
          setOffset(0);
        }}
      >
        <label>
          Search users
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or email"
            type="search"
            maxLength={200}
          />
        </label>
        <label>
          Show
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setOffset(0);
            }}
          >
            <option value="all">All users</option>
            <option value="pending">Awaiting approval</option>
            <option value="organizers">Organizers</option>
            <option value="inactive">Inactive users</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <p className="ops-muted">
        Every change gets a review first. Access changes may cancel future
        registrations. Promotion requires a verified email and a submitted,
        active, approved application. Role changes sign the user out.
      </p>
      {error && (
        <p className="ops-notice ops-danger" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Loading users…</p>}
      {data && (
        <>
          <div
            className="ops-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="User accounts"
          >
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Access</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.name || "Unnamed account"}</strong>
                      <br />
                      {user.email}
                      <br />
                      <span className="ops-muted">
                        {user.verified ? "Verified" : "Email not verified"} ·{" "}
                        {user.role}
                      </span>
                    </td>
                    <td>
                      <div className="ops-user-flags">
                        <span>{user.active ? "Active" : "Inactive"}</span>
                        <span>
                          {user.submitted
                            ? user.applicationApproved
                              ? "Application approved"
                              : "Awaiting approval"
                            : "No application"}
                        </span>
                        <span>
                          {user.patrolApproved
                            ? "Patrol approved"
                            : "Patrol not approved"}
                        </span>
                        <span>
                          {user.orientationCompleted
                            ? "Orientation completed"
                            : "Orientation not recorded"}
                        </span>
                      </div>
                    </td>
                    <td>
                      <details>
                        <summary>Manage</summary>
                        <div className="ops-user-actions">
                          <button
                            disabled={!canWrite}
                            onClick={() =>
                              prepare({
                                action: "role",
                                id: user.id,
                                value:
                                  user.role === "organizer"
                                    ? "volunteer"
                                    : "organizer",
                              })
                            }
                          >
                            {user.role === "organizer"
                              ? "Make volunteer"
                              : "Make organizer"}
                          </button>
                          <button
                            disabled={!canWrite}
                            onClick={() => access(user, "applicationApproved")}
                          >
                            {user.applicationApproved
                              ? "Revoke application approval"
                              : "Approve application"}
                          </button>
                          <button
                            disabled={!canWrite}
                            onClick={() => access(user, "patrolApproved")}
                          >
                            {user.patrolApproved
                              ? "Revoke patrol approval"
                              : "Approve for patrols"}
                          </button>
                          <button
                            disabled={!canWrite}
                            onClick={() => access(user, "active")}
                          >
                            {user.active ? "Deactivate" : "Reactivate"}
                          </button>
                          <button
                            disabled={!canWrite}
                            onClick={() =>
                              prepare({
                                action: "revoke-sessions",
                                id: user.id,
                              })
                            }
                          >
                            Sign out everywhere
                          </button>
                          <button
                            className="ops-text-danger"
                            disabled={!canWrite}
                            onClick={() =>
                              prepare({ action: "delete-user", id: user.id })
                            }
                          >
                            Permanently delete
                          </button>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.users.length && <p>No users match this filter.</p>}
          <div className="ops-buttons">
            <button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 30))}
            >
              Previous
            </button>
            <span>Page {offset / 30 + 1}</span>
            <button
              disabled={!data.hasMore}
              onClick={() => setOffset(offset + 30)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function EventItem({
  event,
  api,
  database,
  canWrite,
  prepare,
  refresh,
}: {
  event: Row;
  api: Api;
  database: string;
  canWrite: boolean;
  prepare: (input: ActionInput) => void;
  refresh: number;
}) {
  const [roster, setRoster] = useState<Row[]>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [capacity, setCapacity] = useState(String(event.spots));
  const future = Number(event.startsAt) > Date.now();
  const editable = canWrite && future && !event.cancelledAt;
  useEffect(() => {
    setCapacity(String(event.spots));
  }, [event.spots]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    setRoster(undefined);
    void api<{ registrations: Row[] }>("roster", {
      query: { database, event: String(event.id) },
      signal: controller.signal,
    })
      .then((data) => setRoster(data.registrations))
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [open, refresh, api, database, event.id]);
  return (
    <article className="ops-panel">
      <h3>{date(event.startsAt)}</h3>
      <p>
        {event.includesOrientation ? "Orientation + Patrol" : "Patrol"} ·{" "}
        {String(event.meetingPoint)}
      </p>
      <p>
        <strong>
          {number(event.confirmed)} / {number(event.spots)}
        </strong>{" "}
        registered · {number(event.medics)} medics
        {Boolean(event.includesOrientation) &&
          ` · ${number(event.orientees)} orientees`}
      </p>
      <p className="ops-muted">
        {event.cancelledAt
          ? "Cancelled"
          : `${event.open ? "Registration open" : "Registration closed"} · ${event.hidden ? "Hidden" : "Visible"}`}
        {event.seriesId ? " · Recurring occurrence" : " · One-off event"}
      </p>
      <div className="ops-buttons">
        <button
          disabled={!editable}
          onClick={() =>
            prepare({
              action: "event-visibility",
              id: String(event.id),
              field: "open",
              value: !event.open,
            })
          }
        >
          {event.open ? "Close registration" : "Open registration"}
        </button>
        <button
          disabled={!editable}
          onClick={() =>
            prepare({
              action: "event-visibility",
              id: String(event.id),
              field: "hidden",
              value: !event.hidden,
            })
          }
        >
          {event.hidden ? "Show event" : "Hide event"}
        </button>
        <button
          className="ops-text-danger"
          disabled={!editable}
          onClick={() =>
            prepare({ action: "cancel-event", id: String(event.id) })
          }
        >
          Cancel event
        </button>
      </div>
      <form
        className="ops-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          prepare({
            action: "event-capacity",
            id: String(event.id),
            value: Number(capacity),
          });
        }}
      >
        <label>
          Capacity
          <input
            type="number"
            min={event.includesOrientation ? 4 : 2}
            max="100"
            step="1"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            disabled={!editable}
          />
        </label>
        <button type="submit" disabled={!editable}>
          Review capacity
        </button>
      </form>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Registrations ({number(event.confirmed)})</summary>
        {error && <p role="alert">{error}</p>}
        {open && !roster && !error && (
          <p role="status">Loading registrations…</p>
        )}
        {roster &&
          (roster.length ? (
            <ul className="ops-roster">
              {roster.map((person) => (
                <li key={String(person.id)}>
                  <div>
                    <strong>{person.name}</strong>
                    <br />
                    <span className="ops-muted">
                      {person.category}
                      {person.completed ? " · Completed this orientation" : ""}
                    </span>
                  </div>
                  <div className="ops-buttons">
                    {future ? (
                      <button
                        disabled={!editable}
                        onClick={() =>
                          prepare({
                            action: "remove-registration",
                            id: String(person.id),
                          })
                        }
                      >
                        Remove
                      </button>
                    ) : (
                      Boolean(event.includesOrientation) &&
                      !person.completed &&
                      !event.cancelledAt && (
                        <button
                          disabled={!canWrite}
                          onClick={() =>
                            prepare({
                              action: "complete-orientation",
                              id: String(person.id),
                            })
                          }
                        >
                          Mark orientation completed
                        </button>
                      )
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>No confirmed registrations.</p>
          ))}
      </details>
    </article>
  );
}

function Email({
  overview,
  api,
  refresh,
}: {
  overview?: Overview;
  api: Api;
  refresh: number;
}) {
  const [data, setData] = useState<ResendUsage>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<ResendUsage>("resend", { signal: controller.signal })
      .then(setData)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [api, refresh]);
  return (
    <section aria-labelledby="ops-email-heading">
      <h2 id="ops-email-heading">Email and background jobs</h2>
      <div className="ops-panel">
        <h3>Resend account limits</h3>
        <p className="ops-muted">
          Account-wide, across all databases and applications. This dashboard
          only reads usage; it cannot send mail or change Resend settings.
          Results are cached for one minute.
        </p>
        {error && (
          <p className="ops-notice ops-danger" role="alert">
            {error}
          </p>
        )}
        {!data && !error && <p role="status">Loading Resend limits…</p>}
        {data && !data.configured && (
          <p className="ops-notice">
            Add <code>DOCS_DASHBOARD_RESEND_API_KEY</code> to{" "}
            <code>docs/.env.local</code> with your dashboard-only full-access
            Resend key, then refresh. Never use a <code>PUBLIC_</code> variable
            or commit the key.
          </p>
        )}
        {data?.configured && (
          <>
            <div className="ops-grid">
              {(
                [
                  ["Daily email", data.usage?.emails?.daily],
                  ["Monthly email", data.usage?.emails?.monthly],
                  ["Contacts", data.usage?.contacts],
                  ["Domains", data.usage?.domains],
                ] as [string, Quota | undefined][]
              ).map(
                ([label, quota]) =>
                  quota && (
                    <div key={label}>
                      <h4>{label}</h4>
                      <p>
                        <strong>{number(quota.used)}</strong> /{" "}
                        {quota.limit === null ? "No cap" : number(quota.limit)}
                      </p>
                      {quota.limit !== null && quota.limit > 0 && (
                        <progress
                          aria-label={`${label} quota used`}
                          value={quota.used}
                          max={quota.limit}
                        />
                      )}
                      {quota.resets_at && (
                        <p className="ops-muted">
                          Resets {date(quota.resets_at)}
                        </p>
                      )}
                    </div>
                  ),
              )}
            </div>
            <p className="ops-muted">
              API rate limit: {number(data.usage?.rate_limit?.limit)} requests /{" "}
              {data.usage?.rate_limit?.duration ?? "—"}. Retrieved{" "}
              {date(data.loadedAt)}.
            </p>
          </>
        )}
      </div>
      <h3>Database delivery ledgers</h3>
      <p className="ops-muted">
        Status and lease timestamps come from D1, not live Worker logs. A
        sending lease in the past or repeated attempts merits investigation.
        “Sent” records provider acceptance, not inbox delivery. No retry/send
        control is exposed here.
      </p>
      {overview?.warnings.map((warning) => (
        <p className="ops-notice" key={warning}>
          {warning}
        </p>
      ))}
      {overview?.queues.map((queue) => (
        <article className="ops-panel" key={queue.name}>
          <h3>{queue.name}</h3>
          <div className="ops-buttons">
            {queue.rows.map((row) => (
              <span className="ops-chip" key={String(row.status)}>
                {row.status}: {number(row.count)}
              </span>
            ))}
          </div>
          <details>
            <summary>Recent delivery state</summary>
            <RowTable rows={queue.recent} empty="No delivery records." />
          </details>
        </article>
      ))}
      {!overview && (
        <p>
          Select a supported application database to inspect its email queues.
        </p>
      )}
    </section>
  );
}

function Health({
  inspection,
  api,
  refresh,
}: {
  inspection: Inspection;
  api: Api;
  refresh: number;
}) {
  const [days, setDays] = useState<Row[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setDays(undefined);
    void api<{
      days: { dimensions: { date: string }; sum: Row; quantiles?: Row }[];
    }>("metrics", {
      query: { database: inspection.database.id },
      signal: controller.signal,
    })
      .then((data) =>
        setDays(
          data.days.map((day) => ({
            date: day.dimensions.date,
            ...day.sum,
            p90LatencyMs: day.quantiles?.queryBatchTimeMsP90 ?? null,
          })),
        ),
      )
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [inspection.database.id, api, refresh]);
  return (
    <section aria-labelledby="ops-health-heading">
      <h2 id="ops-health-heading">Database health</h2>
      <div className="ops-panel">
        <h3>Cloudflare metadata</h3>
        <dl className="ops-impact">
          {Object.entries(inspection.metadata).map(([key, value]) => (
            <div key={key}>
              <dt>{title(key)}</dt>
              <dd>
                {typeof value === "object"
                  ? JSON.stringify(value)
                  : key === "file_size"
                    ? `${number(value)} bytes`
                    : String(value)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="ops-muted">
          Schema inspection succeeded. This is not an integrity check, backup,
          or guarantee of service availability.
        </p>
      </div>
      <div className="ops-panel">
        <h3>D1 usage · last seven UTC dates</h3>
        {error ? (
          <p className="ops-notice" role="status">
            {error} Usage metrics may need additional Account Analytics Read
            permission.
          </p>
        ) : days ? (
          <RowTable
            rows={days}
            empty="No usage metrics returned for this period."
          />
        ) : (
          <p role="status">Loading analytics…</p>
        )}
        <p className="ops-muted">
          Read/write query counts are not billing row counts. Includes all
          traffic to this database, including dashboard reads. Provider metrics
          can be delayed.
        </p>
      </div>
      <div className="ops-panel">
        <h3>Schema ({inspection.tables.length} tables)</h3>
        <p>
          {inspection.compatible
            ? "Supported application schema detected. Dedicated admin actions are available."
            : "This schema is not supported for app-specific actions. Metadata, schema and D1 usage remain available. No arbitrary SQL or table editing is exposed."}
        </p>
        {inspection.missing.length > 0 && (
          <details>
            <summary>Missing application columns</summary>
            <p className="ops-mono">{inspection.missing.join(", ")}</p>
          </details>
        )}
        {inspection.tables.map((table) => (
          <details key={table.name}>
            <summary>
              {table.name} ({table.columns.length} columns)
            </summary>
            <p className="ops-mono">{table.columns.join(", ")}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Activity({
  api,
  database,
  refresh,
}: {
  api: Api;
  database: string;
  refresh: number;
}) {
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<{ entries: AuditEntry[] }>("audit", {
      query: { database },
      signal: controller.signal,
    })
      .then((data) => setEntries(data.entries))
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [api, database, refresh]);
  return (
    <section aria-labelledby="ops-activity-heading">
      <h2 id="ops-activity-heading">Admin activity</h2>
      <p className="ops-muted">
        Latest 100 local records for this database. Stored in{" "}
        <code>.wrangler/docs-dashboard/activity.jsonl</code>, not in D1. An
        action is recorded before execution and again on completion. “Unknown”
        or a lone “started” entry means inspect the data before retrying. This
        local log is not tamper-proof or a record of changes made elsewhere.
      </p>
      {error && <p role="alert">{error}</p>}
      {entries ? (
        <RowTable
          rows={entries.map((entry) => ({
            time: entry.time,
            operator: entry.operator,
            action: entry.action,
            subject: entry.subject ?? "—",
            outcome: entry.outcome,
            code: entry.code ?? "—",
            operation: entry.id,
          }))}
          empty="No local dashboard actions recorded for this database."
        />
      ) : (
        !error && <p role="status">Loading activity…</p>
      )}
    </section>
  );
}

export default function OperationsDashboard() {
  const csrf = useRef("");
  const [api] = useState<Api>(
    () =>
      async (route: string, options: ApiOptions = {}) => {
        const url = new URL(endpoint + route, location.origin);
        for (const [key, value] of Object.entries(options.query ?? {}))
          url.searchParams.set(key, value);
        const response = await fetch(url, {
          method: options.body === undefined ? "GET" : "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            ...(csrf.current ? { "X-Dashboard-CSRF": csrf.current } : {}),
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: options.signal,
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "The dashboard request failed.");
        return result;
      },
  );
  const [databases, setDatabases] = useState<Database[]>([]);
  const [database, setDatabase] = useState("");
  const [inspection, setInspection] = useState<Inspection>();
  const [overview, setOverview] = useState<Overview>();
  const [section, setSection] = useState<Section>("overview");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unlockName, setUnlockName] = useState("");
  const [plan, setPlan] = useState<Plan>();
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [planError, setPlanError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [now, setNow] = useState(Date.now());

  const connect = async () => {
    setConnecting(true);
    setError("");
    try {
      const session = await api<{ csrf: string }>("session");
      csrf.current = session.csrf;
      const data = await api<{ databases: Database[] }>("databases", {
        query: { refresh: "1" },
      });
      setDatabases(data.databases);
      setDatabase((selected) =>
        data.databases.some((item) => item.id === selected)
          ? selected
          : (data.databases.find((item) => item.environment === "preview")
              ?.id ?? ""),
      );
      setRefresh((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setConnecting(false);
    }
  };
  useEffect(() => {
    void connect();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!autoRefresh || plan || planning || applying) return;
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !document.activeElement?.matches("input,select,textarea")
      )
        setRefresh((value) => value + 1);
    }, 60_000);
    return () => clearInterval(timer);
  }, [autoRefresh, plan, planning, applying]);
  useEffect(() => {
    if (!database) {
      setInspection(undefined);
      setOverview(undefined);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      const result = await api<Inspection>("inspect", {
        query: { database },
        signal: controller.signal,
      });
      setInspection(result);
      if (!result.compatible) {
        setSection((value) =>
          ["overview", "users", "events"].includes(value) ? "health" : value,
        );
        setOverview(undefined);
        return;
      }
      const data = await api<Overview>("overview", {
        query: { database },
        signal: controller.signal,
      });
      setOverview(data);
    })()
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, database, refresh]);
  const current = inspection?.database.id === database ? inspection : undefined;
  const canWrite =
    !!current?.compatible &&
    (current.database.environment === "preview" || current.unlockedUntil > now);
  const prepare = async (input: ActionInput) => {
    if (!canWrite || planning) return;
    setPlanning(true);
    setError("");
    setPlanError("");
    setNotice("");
    try {
      setPlan(await api<Plan>("plan", { body: { database, input } }));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPlanning(false);
    }
  };
  const apply = async (confirmation: string) => {
    if (!plan || applying) return;
    setApplying(true);
    setPlanError("");
    try {
      const result = await api<{ message: string }>("execute", {
        body: { database, token: plan.token, confirmation },
      });
      setPlan(undefined);
      setNotice(result.message);
      setRefresh((value) => value + 1);
    } catch (error) {
      setPlanError(errorMessage(error));
    } finally {
      setApplying(false);
    }
  };
  const changeLock = async (unlock: boolean) => {
    setPlanning(true);
    setError("");
    try {
      const data = await api<{ unlockedUntil: number }>(
        unlock ? "unlock" : "lock",
        { body: { database, confirmation: unlockName } },
      );
      setInspection(
        (value) => value && { ...value, unlockedUntil: data.unlockedUntil },
      );
      setUnlockName("");
      setNow(Date.now());
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPlanning(false);
    }
  };
  const sections: [Section, string][] = [
    ["overview", "Overview"],
    ["users", "Users"],
    ["events", "Events"],
    ["email", "Email and jobs"],
    ["health", "Database health"],
    ["activity", "Activity"],
  ];
  return (
    <div className="ops" aria-busy={loading || planning || applying}>
      <p className="ops-intro">
        Local administration of remote D1 databases. Uses your Wrangler login on
        this computer. Nothing here is available in a deployed build.{" "}
        <a href="/operations-dashboard/">Setup and safeguards</a>.
      </p>
      <div className="ops-toolbar ops-connection">
        <label>
          Database
          <select
            value={database}
            disabled={connecting || planning || applying || !!plan}
            onChange={(event) => {
              setDatabase(event.target.value);
              setInspection(undefined);
              setOverview(undefined);
              setNotice("");
              setUnlockName("");
            }}
          >
            <option value="">Select a database</option>
            {databases.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ·{" "}
                {item.environment === "preview" ? "Preview" : "Protected"}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void connect()}
          disabled={connecting || applying || !!plan}
        >
          <RefreshIcon />
          {connecting ? "Connecting…" : "Reconnect"}
        </button>
        <button
          onClick={() => setRefresh((value) => value + 1)}
          disabled={!database || loading || applying || !!plan}
        >
          <RefreshIcon />
          Refresh
        </button>
        <label className="ops-check">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          Refresh every minute
        </label>
      </div>
      {error && (
        <p className="ops-notice ops-danger" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ops-notice ops-success" role="status">
          {notice}
        </p>
      )}
      {planning && (
        <p className="ops-muted" role="status">
          Checking the target and preparing a safe review…
        </p>
      )}
      {!connecting && !databases.length && !error && (
        <p>
          No databases discovered. Confirm the configured Cloudflare account and
          Wrangler permissions.
        </p>
      )}
      {database && (
        <>
          {current && (
            <div
              className={`ops-notice ${current.database.environment === "preview" ? "" : "ops-protected"}`}
            >
              <div className="ops-database-heading">
                <LockIcon />
                <strong>{current.database.name}</strong>
                <span>
                  {current.database.environment === "preview"
                    ? "Configured preview"
                    : "Production / unclassified · protected"}
                </span>
              </div>
              <p className="ops-mono">
                Account {current.database.accountId}
                <br />
                Database {current.database.id}
              </p>
              {current.database.environment !== "preview" &&
                (canWrite ? (
                  <div className="ops-buttons">
                    <span>
                      Writes unlocked until {date(current.unlockedUntil)}.
                    </span>
                    <button
                      onClick={() => void changeLock(false)}
                      disabled={planning || applying || !!plan}
                    >
                      Lock now
                    </button>
                  </div>
                ) : (
                  <form
                    className="ops-toolbar"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void changeLock(true);
                    }}
                  >
                    <label>
                      Read-only. Type the exact database name to unlock writes
                      for 10 minutes
                      <input
                        value={unlockName}
                        onChange={(event) => setUnlockName(event.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={
                        !current.compatible ||
                        unlockName !== current.database.name ||
                        planning
                      }
                    >
                      <LockIcon />
                      Unlock writes
                    </button>
                  </form>
                ))}
              {current.database.environment === "preview" && (
                <p>
                  Changes still require a review. Deletions require a typed
                  confirmation.
                </p>
              )}
            </div>
          )}
          <nav className="ops-sections" aria-label="Dashboard sections">
            {sections.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSection(key)}
                aria-pressed={section === key}
                disabled={
                  planning ||
                  applying ||
                  !!plan ||
                  !current ||
                  (!current.compatible &&
                    ["overview", "users", "events"].includes(key))
                }
              >
                {label}
              </button>
            ))}
          </nav>
          {loading && (
            <p className="ops-muted" role="status">
              Refreshing database snapshot…
            </p>
          )}
          {current && (
            <div className="ops-section" key={database}>
              {section === "overview" && overview && (
                <section aria-labelledby="ops-overview-heading">
                  <h2 id="ops-overview-heading">Application overview</h2>
                  <p className="ops-muted">
                    Snapshot retrieved {date(overview.loadedAt)}. Refresh does
                    not run background jobs or send emails.
                  </p>
                  <Stats counts={overview.counts} />
                  <div className="ops-panel">
                    <h3>Safe administration</h3>
                    <p>
                      Use Users to approve applications, change roles,
                      deactivate accounts or review permanent deletion. Role and
                      access changes follow database safety guards; the last
                      usable organizer is protected. All writes use fixed,
                      parameterized operations—there is no arbitrary SQL
                      console.
                    </p>
                    <p>
                      Events provides per-occurrence visibility, capacity,
                      registration and cancellation controls. Series schedules
                      and bulk recurrence changes remain in the application’s
                      organizer interface.
                    </p>
                    <p>
                      Resend limits are account-wide. Delivery ledgers show
                      queued jobs, not proof that the scheduled Worker is
                      running.
                    </p>
                  </div>
                </section>
              )}
              {section === "users" && current.compatible && (
                <Users
                  api={api}
                  database={database}
                  refresh={refresh}
                  canWrite={canWrite && !planning}
                  prepare={(input) => void prepare(input)}
                />
              )}
              {section === "events" && overview && (
                <section aria-labelledby="ops-events-heading">
                  <h2 id="ops-events-heading">Events and registrations</h2>
                  <p className="ops-muted">
                    Up to 60 occurrences, upcoming first, then recent history.
                    Writes affect only the selected occurrence. Existing
                    reservation rules remain enforced.
                  </p>
                  <div className="ops-grid">
                    {overview.events.map((event) => (
                      <EventItem
                        key={String(event.id)}
                        event={event}
                        api={api}
                        database={database}
                        canWrite={canWrite && !planning}
                        prepare={(input) => void prepare(input)}
                        refresh={refresh}
                      />
                    ))}
                  </div>
                  {!overview.events.length && <p>No events found.</p>}
                  <h3>Recurring series</h3>
                  <RowTable
                    rows={overview.series}
                    empty="No recurring series."
                  />
                </section>
              )}
              {section === "email" && (
                <Email overview={overview} api={api} refresh={refresh} />
              )}
              {section === "health" && (
                <Health inspection={current} api={api} refresh={refresh} />
              )}
              {section === "activity" && (
                <Activity api={api} database={database} refresh={refresh} />
              )}
            </div>
          )}
        </>
      )}
      {plan && (
        <ReviewDialog
          plan={plan}
          onCancel={() => {
            setPlan(undefined);
            setPlanError("");
          }}
          onApply={(confirmation) => void apply(confirmation)}
          busy={applying}
          error={planError}
        />
      )}
    </div>
  );
}
