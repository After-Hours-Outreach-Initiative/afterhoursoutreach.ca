import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = () => integer({ mode: "timestamp_ms" });

// Column keys match their SQL names; Better Auth maps its API fields in ../auth.
// Better Auth's core and plugin tables.
export const user = sqliteTable(
  "user",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().notNull().unique(),
    email_verified: integer({ mode: "boolean" }).notNull().default(false),
    image: text(),
    role: text({ enum: ["volunteer", "organizer"] })
      .notNull()
      .default("volunteer"),
    two_factor_enabled: integer({ mode: "boolean" }).notNull().default(false),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  (table) => [
    check("user_role", sql`${table.role} IN ('volunteer', 'organizer')`),
    uniqueIndex("user_email_case_insensitive").on(sql`lower(${table.email})`),
  ],
);

export const session = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expires_at: timestamp().notNull(),
    ip_address: text(),
    user_agent: text(),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
    two_factor_verified: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("session_user").on(table.user_id)],
);

export const account = sqliteTable(
  "account",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    account_id: text().notNull(),
    provider_id: text().notNull(),
    access_token: text(),
    refresh_token: text(),
    id_token: text(),
    access_token_expires_at: timestamp(),
    refresh_token_expires_at: timestamp(),
    scope: text(),
    password: text(),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  (table) => [
    index("account_user").on(table.user_id),
    uniqueIndex("account_provider_identity").on(
      table.provider_id,
      table.account_id,
    ),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expires_at: timestamp().notNull(),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  (table) => [index("verification_identifier").on(table.identifier)],
);

export const twoFactor = sqliteTable("two_factor", {
  id: text().primaryKey(),
  user_id: text()
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  secret: text().notNull(),
  backup_codes: text().notNull(),
  verified: integer({ mode: "boolean" }).notNull().default(true),
  failed_verification_count: integer().notNull().default(0),
  locked_until: timestamp(),
});

export const authRateLimit = sqliteTable(
  "auth_rate_limit",
  {
    key: text().primaryKey(),
    count: integer().notNull(),
    expires_at: timestamp().notNull(),
  },
  (table) => [index("auth_rate_limit_expiry").on(table.expires_at)],
);

export const profile = sqliteTable("profile", {
  user_id: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  preferred_name: text().notNull(),
  pronouns: text(),
  phone: text().notNull(),
  // Birth dates are calendar dates (YYYY-MM-DD), not UTC timestamps.
  birth_date: text().notNull(),
  emergency_contact_name: text().notNull(),
  emergency_contact_phone: text().notNull(),
  emergency_contact_relationship: text().notNull(),
  heard_about_us: text().notNull(),
  motivation: text().notNull(),
  teams: text({ mode: "json" }).$type<string[]>().notNull(),
  medical_certification: text().notNull(),
  training_experience: text().notNull(),
  medical_conditions: text(),
  registered_at: timestamp().notNull(),
  updated_at: timestamp().notNull(),
});

export const volunteerStatus = sqliteTable(
  "volunteer_status",
  {
    user_id: text()
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    active: integer({ mode: "boolean" }).notNull().default(true),
    patrol_approved: integer({ mode: "boolean" }).notNull().default(false),
    approved_by: text().references(() => user.id),
    approved_at: timestamp(),
    updated_at: timestamp().notNull(),
  },
  (table) => [
    check(
      "approval_has_organizer",
      sql`${table.patrol_approved} = 0 OR (${table.approved_by} IS NOT NULL AND ${table.approved_at} IS NOT NULL)`,
    ),
  ],
);

export const event = sqliteTable(
  "event",
  {
    id: text().primaryKey(),
    type: text({ enum: ["patrol", "orientation"] }).notNull(),
    // Store an absolute instant; show times in America/Vancouver in the UI.
    starts_at: timestamp().notNull(),
    meeting_point: text().notNull(),
    meeting_point_url: text(),
    spots: integer().notNull(),
    open: integer({ mode: "boolean" }).notNull().default(true),
    hidden: integer({ mode: "boolean" }).notNull().default(false),
    cancelled_at: timestamp(),
    created_by: text()
      .notNull()
      .references(() => user.id),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  (table) => [
    check("event_type", sql`${table.type} IN ('patrol', 'orientation')`),
    check("event_positive_spots", sql`${table.spots} > 0`),
    check("event_hidden_boolean", sql`${table.hidden} IN (0, 1)`),
    index("event_starts_at").on(table.starts_at),
  ],
);

export const signup = sqliteTable(
  "signup",
  {
    id: text().primaryKey(),
    event_id: text()
      .notNull()
      .references(() => event.id),
    user_id: text()
      .notNull()
      .references(() => user.id),
    status: text({ enum: ["confirmed", "cancelled"] })
      .notNull()
      .default("confirmed"),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  (table) => [
    check("signup_status", sql`${table.status} IN ('confirmed', 'cancelled')`),
    uniqueIndex("signup_one_confirmed_spot")
      .on(table.event_id, table.user_id)
      .where(sql`${table.status} = 'confirmed'`),
    index("signup_event_status").on(table.event_id, table.status),
    index("signup_user").on(table.user_id),
  ],
);

export const orientationCompletion = sqliteTable(
  "orientation_completion",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => user.id),
    event_id: text()
      .notNull()
      .references(() => event.id),
    marked_by: text()
      .notNull()
      .references(() => user.id),
    marked_at: timestamp().notNull(),
  },
  (table) => [
    uniqueIndex("orientation_completion_user_event").on(
      table.user_id,
      table.event_id,
    ),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text().primaryKey(),
    actor_id: text()
      .notNull()
      .references(() => user.id),
    subject_id: text()
      .notNull()
      .references(() => user.id),
    action: text({
      enum: [
        "profile_viewed",
        "profile_updated",
        "approval_changed",
        "role_changed",
        "active_changed",
        "orientation_completed",
      ],
    }).notNull(),
    // Log field names, not copies of sensitive profile answers.
    changed_fields: text({ mode: "json" }).$type<string[]>(),
    created_at: timestamp().notNull(),
  },
  (table) => [
    index("audit_log_subject_time").on(table.subject_id, table.created_at),
  ],
);

export const eventAudit = sqliteTable(
  "event_audit",
  {
    id: text().primaryKey(),
    event_id: text()
      .notNull()
      .references(() => event.id),
    actor_id: text()
      .notNull()
      .references(() => user.id),
    action: text().notNull(),
    changed_fields: text({ mode: "json" }).$type<string[]>(),
    created_at: timestamp().notNull(),
  },
  (table) => [index("event_audit_time").on(table.event_id, table.created_at)],
);

export const eventNotification = sqliteTable(
  "event_notification",
  {
    id: text().primaryKey(),
    operation_id: text().notNull(),
    user_id: text()
      .notNull()
      .references(() => user.id),
    subject: text().notNull(),
    body: text().notNull(),
    // Freeze the sending origin across retries on previews sharing one D1.
    delivery_origin: text(),
    status: text({ enum: ["pending", "sending", "sent", "local"] })
      .notNull()
      .default("pending"),
    attempts: integer().notNull().default(0),
    lease_until: timestamp(),
    created_at: timestamp().notNull(),
    sent_at: timestamp(),
  },
  (table) => [
    index("event_notification_pending").on(table.status, table.created_at),
    index("event_notification_operation").on(table.operation_id),
    check(
      "event_notification_status",
      sql`${table.status} IN ('pending','sending','sent','local')`,
    ),
  ],
);

export const organizerBootstrap = sqliteTable(
  "organizer_bootstrap",
  {
    id: integer().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => user.id),
    created_at: timestamp().notNull(),
  },
  (table) => [check("organizer_bootstrap_once", sql`${table.id} = 1`)],
);
