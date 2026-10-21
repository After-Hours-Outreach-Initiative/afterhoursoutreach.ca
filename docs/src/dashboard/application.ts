import { randomUUID } from "node:crypto";
import { Cloudflare, DashboardError, type Statement } from "./cloudflare";
import type {
  ActionInput,
  Database,
  Overview,
  Plan,
  Row,
  SchemaTable,
  User,
} from "./types";

const required: Record<string, string[]> = {
  user: [
    "id",
    "name",
    "email",
    "email_verified",
    "role",
    "created_at",
    "updated_at",
  ],
  profile: ["user_id", "first_name", "last_name", "teams"],
  volunteer_status: [
    "user_id",
    "active",
    "registration_approved",
    "patrol_approved",
    "approved_by",
    "approved_at",
    "updated_at",
  ],
  session: ["id", "user_id"],
  event: [
    "id",
    "type",
    "starts_at",
    "spots",
    "includes_orientation",
    "meeting_point",
    "series_id",
    "open",
    "hidden",
    "cancelled_at",
    "updated_at",
  ],
  signup: ["id", "user_id", "event_id", "status", "updated_at"],
  orientation_completion: [
    "id",
    "user_id",
    "event_id",
    "marked_by",
    "marked_at",
  ],
  event_audit: [
    "id",
    "event_id",
    "actor_id",
    "action",
    "changed_fields",
    "created_at",
  ],
};
export function missingApplicationSchema(tables: SchemaTable[]) {
  return Object.entries(required).flatMap(([name, columns]) => {
    const table = tables.find((item) => item.name === name);
    return columns
      .filter((column) => !table?.columns.includes(column))
      .map((column) => `${name}.${column}`);
  });
}

const userSelect = `SELECT u.id,u.name,u.email,u.role,u.email_verified AS verified,u.updated_at AS updatedAt,
  coalesce(v.active,0) AS active,coalesce(v.registration_approved,0) AS applicationApproved,
  coalesce(v.patrol_approved,0) AS patrolApproved,coalesce(v.updated_at,0) AS statusUpdatedAt,
  EXISTS(SELECT 1 FROM profile p WHERE p.user_id=u.id) AS submitted,
  EXISTS(SELECT 1 FROM orientation_completion o WHERE o.user_id=u.id) AS orientationCompleted
  FROM user u LEFT JOIN volunteer_status v ON v.user_id=u.id`;
const usableOrganizer = `SELECT u.id FROM user u JOIN volunteer_status v ON v.user_id=u.id
  JOIN profile p ON p.user_id=u.id WHERE u.role='organizer' AND v.active=1 AND u.email_verified=1`;
const futureBookings = `SELECT s.id FROM signup s JOIN event e ON e.id=s.event_id
  WHERE s.user_id=? AND s.status='confirmed' AND e.starts_at>? AND e.cancelled_at IS NULL`;
const medic = (
  id: string,
) => `EXISTS(SELECT 1 FROM profile mp JOIN volunteer_status mv ON mv.user_id=mp.user_id
  WHERE mp.user_id=${id} AND mv.registration_approved=1 AND mv.patrol_approved=1
  AND EXISTS(SELECT 1 FROM json_each(mp.teams) WHERE value='medic')
  AND EXISTS(SELECT 1 FROM orientation_completion mo WHERE mo.user_id=mp.user_id))`;
const category = `CASE WHEN coalesce(e.includes_orientation,e.type='orientation') AND NOT EXISTS(
  SELECT 1 FROM orientation_completion o WHERE o.user_id=s.user_id) THEN 'Orientee'
  WHEN ${medic("s.user_id")} THEN 'Medic' ELSE 'Volunteer' END`;

export interface PreparedPlan extends Plan {
  databaseId: string;
  input: ActionInput;
  revision: string;
  statements: Statement[];
}
function assertion(condition: string, params: Statement["params"]): Statement {
  // An assertion error aborts the complete D1 transaction, including all deletes.
  return {
    sql: `SELECT CASE WHEN (${condition}) THEN 1 ELSE json('dashboard_conflict') END AS valid`,
    params,
  };
}
function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw new DashboardError(400, "invalid_input", `Choose a valid ${name}.`);
  return value;
}

export class Application {
  constructor(private cf: Cloudflare) {}
  async requireSchema(db: Database) {
    const tables = await this.cf.schema(db);
    if (missingApplicationSchema(tables).length)
      throw new DashboardError(
        409,
        "unsupported_schema",
        "This database does not have the supported After Hours Outreach schema. App actions are disabled.",
      );
    return tables;
  }
  async users(db: Database, search: string, filter: string, offset: number) {
    const filters: Record<string, string> = {
      all: "1",
      pending:
        "v.registration_approved=0 AND EXISTS(SELECT 1 FROM profile p WHERE p.user_id=u.id)",
      organizers: "u.role='organizer'",
      inactive: "v.active=0",
    };
    const rows = await this.cf.rows(
      db,
      `${userSelect} WHERE (u.name LIKE ? OR u.email LIKE ?) AND (${Object.hasOwn(filters, filter) ? filters[filter] : "1"})
      ORDER BY u.created_at DESC,u.id LIMIT 31 OFFSET ?`,
      [`%${search.slice(0, 200)}%`, `%${search.slice(0, 200)}%`, offset],
    );
    return { users: rows.slice(0, 30) as User[], hasMore: rows.length > 30 };
  }
  async user(db: Database, id: string) {
    const rows = await this.cf.rows(db, `${userSelect} WHERE u.id=?`, [id]);
    if (!rows.length)
      throw new DashboardError(
        404,
        "user_missing",
        "This user no longer exists.",
      );
    return rows[0] as User;
  }
  async overview(db: Database, tables: SchemaTable[]): Promise<Overview> {
    const now = Date.now();
    const [counts, events] = await this.cf.batch(db, [
      {
        sql: `SELECT count(*) AS users,
        sum(u.role='organizer') AS organizers,sum(coalesce(v.active,0)=1) AS active,
        sum(EXISTS(SELECT 1 FROM profile p WHERE p.user_id=u.id) AND coalesce(v.registration_approved,0)=0) AS pending,
        sum(coalesce(v.patrol_approved,0)=1) AS patrolApproved,
        (SELECT count(*) FROM event WHERE starts_at>? AND cancelled_at IS NULL) AS upcomingEvents,
        (SELECT count(*) FROM signup s JOIN event e ON e.id=s.event_id WHERE s.status='confirmed' AND e.starts_at>? AND e.cancelled_at IS NULL) AS registrations
        FROM user u LEFT JOIN volunteer_status v ON v.user_id=u.id`,
        params: [now, now],
      },
      {
        sql: `SELECT e.id,e.starts_at AS startsAt,e.meeting_point AS meetingPoint,e.spots,e.open,e.hidden,
        e.cancelled_at AS cancelledAt,e.series_id AS seriesId,coalesce(e.includes_orientation,e.type='orientation') AS includesOrientation,e.updated_at AS updatedAt,
        (SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed') AS confirmed,
        (SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed' AND ${medic("s.user_id")}) AS medics,
        (SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed' AND NOT EXISTS(SELECT 1 FROM orientation_completion o WHERE o.user_id=s.user_id)) AS orientees
        FROM event e ORDER BY (e.starts_at>?) DESC,CASE WHEN e.starts_at>? THEN e.starts_at END ASC,e.starts_at DESC LIMIT 60`,
        params: [now, now],
      },
    ]);
    const queueSpecs = [
      {
        name: "Event email",
        table: "event_notification",
        columns: [
          "id",
          "status",
          "attempts",
          "created_at",
          "sent_at",
          "lease_until",
        ],
      },
      {
        name: "Application email",
        table: "application_submission_notification",
        columns: [
          "id",
          "mode",
          "status",
          "outcome",
          "attempts",
          "created_at",
          "sent_at",
          "next_attempt_at",
          "lease_until",
        ],
      },
      {
        name: "Medic reminders",
        table: "medic_certification_notification",
        columns: [
          "id",
          "kind",
          "status",
          "attempts",
          "created_at",
          "sent_at",
          "lease_until",
        ],
      },
      {
        name: "Event delivery batches",
        table: "event_notification_batch",
        columns: ["id", "status", "outcome", "created_at", "lease_until"],
      },
    ];
    const queues: Overview["queues"] = [];
    const warnings: string[] = [];
    for (const spec of queueSpecs) {
      const table = tables.find((entry) => entry.name === spec.table);
      if (!table) {
        warnings.push(`${spec.name} table is not installed.`);
        continue;
      }
      const columns = spec.columns.filter((column) =>
        table.columns.includes(column),
      );
      const [summary, recent] = await this.cf.batch(db, [
        {
          sql: `SELECT status,count(*) AS count FROM "${spec.table}" GROUP BY status`,
        },
        {
          sql: `SELECT ${columns.join(",")} FROM "${spec.table}" ORDER BY created_at DESC LIMIT 12`,
        },
      ]);
      queues.push({
        name: spec.name,
        rows: summary.results,
        recent: recent.results,
      });
    }
    const series = tables.some((table) => table.name === "patrol_series")
      ? await this.cf.rows(
          db,
          `SELECT id,meeting_point AS meetingPoint,first_date AS firstDate,local_time AS localTime,
        interval_weeks AS intervalWeeks,end_date AS endDate,stopped_from AS stoppedFrom,spots,open,hidden
        FROM patrol_series ORDER BY created_at DESC LIMIT 50`,
        )
      : [];
    return {
      counts: counts.results[0] ?? {},
      events: events.results,
      series,
      queues,
      warnings,
      loadedAt: now,
    };
  }
  async roster(db: Database, eventId: string) {
    return this.cf.rows(
      db,
      `SELECT s.id,s.user_id AS userId,u.name,s.status,${category} AS category,
      EXISTS(SELECT 1 FROM orientation_completion o WHERE o.event_id=s.event_id AND o.user_id=s.user_id) AS completed
      FROM signup s JOIN user u ON u.id=s.user_id JOIN event e ON e.id=s.event_id
      WHERE s.event_id=? AND s.status='confirmed' ORDER BY u.name LIMIT 100`,
      [eventId],
    );
  }

  async prepare(db: Database, raw: ActionInput): Promise<PreparedPlan> {
    const tables = await this.requireSchema(db);
    const input: ActionInput = {
      action: raw.action,
      id: text(raw.id, "record"),
      ...(raw.value === undefined ? {} : { value: raw.value }),
      ...(raw.field ? { field: raw.field } : {}),
    };
    const plan: PreparedPlan = {
      token: randomUUID(),
      databaseId: db.id,
      input,
      revision: "",
      title: "Review change",
      details: [],
      impact: [],
      confirmation: "",
      blocked: [],
      expiresAt: Date.now() + 2 * 60_000,
      statements: [],
    };
    const now = Date.now();
    if (
      ["role", "access", "revoke-sessions", "delete-user"].includes(
        input.action,
      )
    ) {
      const user = await this.user(db, input.id);
      plan.revision = JSON.stringify(user);
      plan.details.push(
        `${user.name} (${user.email})`,
        `Database: ${db.name} · ${db.id}`,
        "Dashboard actions do not send notification emails.",
      );
      plan.statements.push(
        assertion(
          `EXISTS(SELECT 1 FROM user u LEFT JOIN volunteer_status v ON v.user_id=u.id
        WHERE u.id=? AND u.updated_at=? AND u.role=? AND u.email=? AND u.email_verified=?
        AND coalesce(v.updated_at,0)=? AND coalesce(v.active,0)=? AND coalesce(v.registration_approved,0)=? AND coalesce(v.patrol_approved,0)=?
        AND EXISTS(SELECT 1 FROM profile p WHERE p.user_id=u.id)=?)`,
          [
            user.id,
            user.updatedAt,
            user.role,
            user.email,
            user.verified,
            user.statusUpdatedAt,
            user.active,
            user.applicationApproved,
            user.patrolApproved,
            user.submitted,
          ],
        ),
      );
      const protectsOrganizer = () => {
        if (user.role === "organizer" && user.active)
          plan.statements.push(
            assertion(`EXISTS(${usableOrganizer} AND u.id!=?)`, [user.id]),
          );
      };
      if (input.action === "role") {
        if (input.value !== "organizer" && input.value !== "volunteer")
          throw new DashboardError(
            400,
            "invalid_role",
            "Choose organizer or volunteer.",
          );
        if (input.value === user.role)
          plan.blocked.push("This account already has that role.");
        if (
          input.value === "organizer" &&
          !(
            user.verified &&
            user.submitted &&
            user.active &&
            user.applicationApproved
          )
        )
          plan.blocked.push(
            "An organizer needs a verified email and a submitted, active, approved application. Set those access flags first.",
          );
        if (input.value === "volunteer") protectsOrganizer();
        plan.title = `Set role to ${input.value}`;
        plan.details.push(
          "All sign-in sessions for this user will be revoked.",
        );
        plan.statements.push({
          sql: "UPDATE user SET role=?,updated_at=max(updated_at+1,?) WHERE id=?",
          params: [String(input.value), now, user.id],
        });
        plan.statements.push({
          sql: "DELETE FROM session WHERE user_id=?",
          params: [user.id],
        });
      } else if (input.action === "revoke-sessions") {
        plan.title = "Sign out this user everywhere";
        plan.statements.push({
          sql: "DELETE FROM session WHERE user_id=?",
          params: [user.id],
        });
      } else if (input.action === "access") {
        const fields = {
          active: "active",
          applicationApproved: "registration_approved",
          patrolApproved: "patrol_approved",
        };
        const field = input.field as keyof typeof fields;
        if (!Object.hasOwn(fields, field) || typeof input.value !== "boolean")
          throw new DashboardError(
            400,
            "invalid_access",
            "Choose an access flag and boolean value.",
          );
        const enabled = input.value;
        if (enabled && field !== "active" && !user.submitted)
          plan.blocked.push(
            "The user must submit their application before approval.",
          );
        if (!enabled && field === "active") protectsOrganizer();
        plan.title = `${enabled ? "Enable" : "Disable"} ${field === "active" ? "account access" : field === "applicationApproved" ? "application approval" : "patrol approval"}`;
        let approver: string | null = null;
        if (field === "patrolApproved" && enabled) {
          approver = String(
            (
              await this.cf.rows(db, `${usableOrganizer} ORDER BY u.id LIMIT 1`)
            )[0]?.id ?? "",
          );
          if (!approver)
            plan.blocked.push(
              "Create an active organizer before granting patrol approval.",
            );
          else
            plan.statements.push(
              assertion(`EXISTS(${usableOrganizer} AND u.id=?)`, [approver]),
            );
          plan.details.push(
            "Patrol approval will reference an existing active organizer; the local dashboard activity log identifies this administrative operation.",
          );
        }
        plan.statements.push({
          sql: "INSERT INTO volunteer_status(user_id,active,registration_approved,patrol_approved,updated_at) VALUES(?,0,0,0,?) ON CONFLICT(user_id) DO NOTHING",
          params: [user.id, now],
        });
        plan.statements.push({
          sql:
            field === "patrolApproved"
              ? "UPDATE volunteer_status SET patrol_approved=?,approved_by=?,approved_at=?,updated_at=max(updated_at+1,?) WHERE user_id=?"
              : `UPDATE volunteer_status SET ${fields[field]}=?,updated_at=max(updated_at+1,?) WHERE user_id=?`,
          params:
            field === "patrolApproved"
              ? [
                  Number(enabled),
                  enabled ? approver : null,
                  enabled ? now : null,
                  now,
                  user.id,
                ]
              : [Number(enabled), now, user.id],
        });
        if (!enabled) {
          const restrict =
            field === "patrolApproved"
              ? " AND NOT coalesce(e.includes_orientation,e.type='orientation')"
              : field === "applicationApproved" && user.role === "organizer"
                ? " AND 0"
                : "";
          const count = await this.cf.rows(
            db,
            `SELECT count(*) AS count FROM (${futureBookings}${restrict})`,
            [user.id, now],
          );
          plan.impact.push({
            label: "Upcoming registrations cancelled",
            count: Number(count[0].count),
          });
          plan.statements.push(
            assertion(
              `(SELECT count(*) FROM (${futureBookings}${restrict}))=?`,
              [user.id, now, Number(count[0].count)],
            ),
          );
          plan.statements.push({
            sql: `UPDATE signup SET status='cancelled',updated_at=? WHERE id IN (${futureBookings}${restrict})`,
            params: [now, user.id, now],
          });
          if (field === "active")
            plan.statements.push({
              sql: "DELETE FROM session WHERE user_id=?",
              params: [user.id],
            });
        }
      } else {
        plan.title = "Permanently delete user";
        plan.confirmation = `DELETE ${user.email}`;
        protectsOrganizer();
        plan.details.push(
          "Permanent deletion removes the account and its owned records. It does not erase provider emails, frozen delivery-batch payloads, backups or this local activity log. Deactivation preserves account history and is safer.",
        );
        const owned = new Map<string, string>([
          ["session", "user_id"],
          ["account", "user_id"],
          ["two_factor", "user_id"],
          ["application_draft", "user_id"],
          ["application_draft_generation", "user_id"],
          ["profile", "user_id"],
          ["volunteer_status", "user_id"],
          ["signup", "user_id"],
          ["orientation_completion", "user_id"],
          ["event_notification", "user_id"],
          ["medic_certification_notification", "user_id"],
          ["application_submission_notification", "user_id"],
          ["organizer_bootstrap", "user_id"],
          ["audit_log", "subject_id"],
        ]);
        const dependencyChecks: string[] = [];
        const dependencyParams: NonNullable<Statement["params"]> = [];
        // Discover every foreign-key dependency. Unknown/new relationships block
        // deletion instead of silently dropping history or disabling constraints.
        for (const table of tables) {
          const refs = await this.cf.rows(
            db,
            'SELECT "from" FROM pragma_foreign_key_list(?) WHERE "table"=\'user\'',
            [table.name],
          );
          const own = owned.get(table.name);
          const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
          for (const ref of refs) {
            const column = String(ref.from);
            if (column === own) continue;
            const countSql = `SELECT count(*) AS count FROM ${quote(table.name)} WHERE ${quote(column)}=?${own ? ` AND ${quote(own)}!=?` : ""}`;
            const params = own ? [user.id, user.id] : [user.id];
            const rows = await this.cf.rows(db, countSql, params);
            dependencyChecks.push(`(${countSql})=?`);
            dependencyParams.push(...params, Number(rows[0].count));
            if (Number(rows[0].count))
              plan.blocked.push(
                `${rows[0].count} historical references in ${table.name}.${column}. Deactivate instead; history must not be silently reassigned or removed.`,
              );
          }
          if (own && table.columns.includes(own)) {
            const countSql = `SELECT count(*) AS count FROM ${quote(table.name)} WHERE ${quote(own)}=?`;
            const rows = await this.cf.rows(db, countSql, [user.id]);
            dependencyChecks.push(`(${countSql})=?`);
            dependencyParams.push(user.id, Number(rows[0].count));
            plan.impact.push({
              label: table.name,
              count: Number(rows[0].count),
            });
          }
        }
        // In-transaction checks also prevent an unreviewed cascade if another
        // request adds an unknown dependency after the last read.
        if (dependencyChecks.length)
          plan.statements.push(
            assertion(dependencyChecks.join(" AND "), dependencyParams),
          );
        // Children first; DELETE user still enforces any newly-created FK reference
        // and rolls back the entire batch if history appears after this preview.
        for (const table of [
          "audit_log",
          "orientation_completion",
          "event_notification",
          "signup",
          "organizer_bootstrap",
          "medic_certification_notification",
          "application_submission_notification",
          "application_draft",
          "application_draft_generation",
          "two_factor",
          "account",
          "session",
          "profile",
          "volunteer_status",
        ]) {
          if (!tables.some((entry) => entry.name === table)) continue;
          plan.statements.push({
            sql: `DELETE FROM "${table}" WHERE ${owned.get(table)}=?`,
            params: [user.id],
          });
        }
        plan.statements.push({
          sql: "DELETE FROM user WHERE id=?",
          params: [user.id],
        });
      }
      if (
        user.role === "organizer" &&
        (input.action === "delete-user" ||
          (input.action === "role" && input.value === "volunteer") ||
          (input.action === "access" &&
            input.field === "active" &&
            input.value === false))
      ) {
        const others = await this.cf.rows(
          db,
          `${usableOrganizer} AND u.id!=? LIMIT 1`,
          [user.id],
        );
        if (!others.length)
          plan.blocked.push(
            "The last usable organizer cannot be demoted, deactivated or deleted.",
          );
      }
      return plan;
    }

    const registrationAction = [
      "remove-registration",
      "complete-orientation",
    ].includes(input.action);
    let signup: Row | undefined;
    let eventId = input.id;
    if (registrationAction) {
      signup = (
        await this.cf.rows(
          db,
          "SELECT id,event_id,user_id,status,updated_at FROM signup WHERE id=?",
          [input.id],
        )
      )[0];
      if (!signup)
        throw new DashboardError(
          404,
          "registration_missing",
          "Registration not found.",
        );
      eventId = String(signup.event_id);
      plan.statements.push(
        assertion(
          "EXISTS(SELECT 1 FROM signup WHERE id=? AND updated_at=? AND status='confirmed')",
          [input.id, signup.updated_at],
        ),
      );
    }
    const event = (
      await this.cf.rows(db, "SELECT * FROM event WHERE id=?", [eventId])
    )[0];
    if (!event)
      throw new DashboardError(404, "event_missing", "Event not found.");
    plan.revision = JSON.stringify({ event, signup });
    plan.details.push(
      `${event.meeting_point} · ${new Date(Number(event.starts_at)).toISOString()}`,
      `Database: ${db.name} · ${db.id}`,
      "No notification emails are sent by dashboard actions.",
    );
    if (signup) {
      const person = await this.user(db, String(signup.user_id));
      plan.details.push(`Registrant: ${person.name} (${person.email})`);
    }
    plan.statements.push(
      assertion(
        `EXISTS(SELECT 1 FROM event WHERE id=? AND updated_at=? AND cancelled_at IS NULL
          AND starts_at ${input.action === "complete-orientation" ? "<=" : ">"}
          CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER))`,
        [eventId, event.updated_at],
      ),
    );
    if (event.cancelled_at)
      plan.blocked.push("This event is already cancelled.");
    if (
      input.action !== "complete-orientation" &&
      Number(event.starts_at) <= now
    )
      plan.blocked.push(
        "Past events and registrations cannot be changed here.",
      );
    if (!registrationAction) {
      const organizer = (
        await this.cf.rows(db, `${usableOrganizer} ORDER BY u.id LIMIT 1`)
      )[0];
      if (!organizer)
        plan.blocked.push("Create an active organizer before changing events.");
      else {
        plan.statements.push(
          assertion(`EXISTS(${usableOrganizer} AND u.id=?)`, [organizer.id]),
        );
        const fields =
          input.action === "event-capacity"
            ? ["spots"]
            : input.action === "cancel-event"
              ? ["cancelledAt"]
              : [input.field === "open" ? "open" : "hidden"];
        // Canonical 'updated' history is also the recurrence exception marker.
        // Without it a later series edit could overwrite this occurrence.
        plan.statements.push({
          sql: "INSERT INTO event_audit(id,event_id,actor_id,action,changed_fields,created_at) VALUES(?,?,?,?,?,?)",
          params: [
            randomUUID(),
            eventId,
            organizer.id,
            input.action === "cancel-event" ? "cancelled" : "updated",
            JSON.stringify(fields),
            now,
          ],
        });
        plan.details.push(
          "The event history references an active organizer; the dashboard log identifies this local administrative operation.",
        );
      }
    }
    const updateTime = Math.max(now, Number(event.updated_at) + 1);
    switch (input.action) {
      case "event-visibility": {
        if (
          !["open", "hidden"].includes(input.field ?? "") ||
          typeof input.value !== "boolean"
        )
          throw new DashboardError(
            400,
            "invalid_event",
            "Choose visibility or registration state.",
          );
        plan.title = `${input.field === "open" ? "Registration" : "Hidden"}: ${input.value ? "on" : "off"}`;
        plan.details.push(
          "Existing registrations are retained. For recurring events this changes only this occurrence, not the series defaults.",
        );
        plan.statements.push({
          sql: `UPDATE event SET ${input.field}=?,updated_at=? WHERE id=?`,
          params: [Number(input.value), updateTime, eventId],
        });
        break;
      }
      case "event-capacity": {
        const value = Number(input.value);
        const minimum =
          (event.includes_orientation ?? event.type === "orientation") ? 4 : 2;
        if (!Number.isInteger(value) || value < minimum || value > 100)
          throw new DashboardError(
            400,
            "invalid_capacity",
            `Capacity must be an integer from ${minimum} to 100.`,
          );
        plan.title = `Change capacity from ${event.spots} to ${value}`;
        plan.details.push(
          "Database reservation and existing-registration guards remain enforced. This affects only this occurrence.",
        );
        plan.statements.push({
          sql: "UPDATE event SET spots=?,updated_at=? WHERE id=?",
          params: [value, updateTime, eventId],
        });
        break;
      }
      case "cancel-event": {
        plan.title = "Cancel event and its registrations";
        plan.confirmation = "CANCEL EVENT";
        plan.details.push(
          "This is permanent for recurring occurrences. Future occurrences in the series are unaffected.",
        );
        const rows = await this.cf.rows(
          db,
          "SELECT count(*) AS count FROM signup WHERE event_id=? AND status='confirmed'",
          [eventId],
        );
        plan.impact.push({
          label: "Registrations cancelled",
          count: Number(rows[0].count),
        });
        plan.statements.push(
          assertion(
            "(SELECT count(*) FROM signup WHERE event_id=? AND status='confirmed')=?",
            [eventId, Number(rows[0].count)],
          ),
        );
        plan.statements.push({
          sql: "UPDATE event SET cancelled_at=?,open=0,hidden=1,updated_at=? WHERE id=?",
          params: [now, updateTime, eventId],
        });
        plan.statements.push({
          sql: "UPDATE signup SET status='cancelled',updated_at=? WHERE event_id=? AND status='confirmed'",
          params: [now, eventId],
        });
        break;
      }
      case "remove-registration":
        plan.title = "Cancel registration";
        plan.details.push(
          "The place and any associated reservation become available again.",
        );
        plan.statements.push({
          sql: "UPDATE signup SET status='cancelled',updated_at=? WHERE id=?",
          params: [now, input.id],
        });
        break;
      case "complete-orientation": {
        plan.title = "Mark orientation completed";
        if (
          Number(event.starts_at) > now ||
          !(event.includes_orientation ?? event.type === "orientation")
        )
          plan.blocked.push(
            "Only registered attendees of an orientation that has started can be marked completed.",
          );
        const organizer = (
          await this.cf.rows(db, `${usableOrganizer} ORDER BY u.id LIMIT 1`)
        )[0];
        if (!organizer)
          plan.blocked.push(
            "An active organizer is needed to reference the completion record.",
          );
        else {
          plan.statements.push(
            assertion(`EXISTS(${usableOrganizer} AND u.id=?)`, [organizer.id]),
          );
          plan.statements.push({
            sql: "INSERT INTO orientation_completion(id,user_id,event_id,marked_by,marked_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,event_id) DO NOTHING",
            params: [randomUUID(), signup!.user_id, eventId, organizer.id, now],
          });
          plan.details.push(
            "This records attendance, not automatic patrol approval. The completion references an active organizer; this local operation is recorded in the dashboard log.",
          );
        }
        break;
      }
      default:
        throw new DashboardError(
          400,
          "unknown_action",
          "This administrative action is not supported.",
        );
    }
    return plan;
  }
}
