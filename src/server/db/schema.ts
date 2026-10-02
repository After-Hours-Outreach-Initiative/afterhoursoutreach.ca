import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

// Better Auth's core and plugin tables.
export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    image: text("image"),
    role: text("role", { enum: ["volunteer", "organizer"] })
      .notNull()
      .default("volunteer"),
    twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    check("user_role", sql`${table.role} IN ('volunteer', 'organizer')`),
    uniqueIndex("user_email_case_insensitive").on(sql`lower(${table.email})`),
  ],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    twoFactorVerified: integer("two_factor_verified", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [index("session_user").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("account_user").on(table.userId),
    uniqueIndex("account_provider_identity").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("verification_identifier").on(table.identifier)],
);

export const twoFactor = sqliteTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  verified: integer("verified", { mode: "boolean" }).notNull().default(true),
  failedVerificationCount: integer("failed_verification_count")
    .notNull()
    .default(0),
  lockedUntil: timestamp("locked_until"),
});

export const emailChallenge = sqliteTable(
  "email_challenge",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    tokenHash: text("token_hash").notNull(),
    returnTo: text("return_to").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("email_challenge_expiry").on(table.expiresAt)],
);

export const authRateLimit = sqliteTable(
  "auth_rate_limit",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [index("auth_rate_limit_expiry").on(table.expiresAt)],
);

export const profile = sqliteTable("profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  preferredName: text("preferred_name").notNull(),
  pronouns: text("pronouns"),
  phone: text("phone").notNull(),
  // Birth dates are calendar dates (YYYY-MM-DD), not UTC timestamps.
  birthDate: text("birth_date").notNull(),
  emergencyContactName: text("emergency_contact_name").notNull(),
  emergencyContactPhone: text("emergency_contact_phone").notNull(),
  emergencyContactRelationship: text(
    "emergency_contact_relationship",
  ).notNull(),
  heardAboutUs: text("heard_about_us").notNull(),
  motivation: text("motivation").notNull(),
  teams: text("teams", { mode: "json" }).$type<string[]>().notNull(),
  medicalCertification: text("medical_certification").notNull(),
  trainingExperience: text("training_experience").notNull(),
  medicalConditions: text("medical_conditions"),
  registeredAt: timestamp("registered_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const volunteerStatus = sqliteTable(
  "volunteer_status",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    patrolApproved: integer("patrol_approved", { mode: "boolean" })
      .notNull()
      .default(false),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: timestamp("approved_at"),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    check(
      "approval_has_organizer",
      sql`${table.patrolApproved} = 0 OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
  ],
);

export const event = sqliteTable(
  "event",
  {
    id: text("id").primaryKey(),
    type: text("type", { enum: ["patrol", "orientation"] }).notNull(),
    // Store an absolute instant; show times in America/Vancouver in the UI.
    startsAt: timestamp("starts_at").notNull(),
    meetingPoint: text("meeting_point").notNull(),
    meetingPointUrl: text("meeting_point_url"),
    spots: integer("spots").notNull(),
    open: integer("open", { mode: "boolean" }).notNull().default(true),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    cancelledAt: timestamp("cancelled_at"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    check("event_type", sql`${table.type} IN ('patrol', 'orientation')`),
    check("event_positive_spots", sql`${table.spots} > 0`),
    check("event_hidden_boolean", sql`${table.hidden} IN (0, 1)`),
    index("event_starts_at").on(table.startsAt),
  ],
);

export const signup = sqliteTable(
  "signup",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => event.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    status: text("status", { enum: ["confirmed", "cancelled"] })
      .notNull()
      .default("confirmed"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    check("signup_status", sql`${table.status} IN ('confirmed', 'cancelled')`),
    uniqueIndex("signup_one_confirmed_spot")
      .on(table.eventId, table.userId)
      .where(sql`${table.status} = 'confirmed'`),
    index("signup_event_status").on(table.eventId, table.status),
    index("signup_user").on(table.userId),
  ],
);

export const orientationCompletion = sqliteTable(
  "orientation_completion",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    eventId: text("event_id")
      .notNull()
      .references(() => event.id),
    markedBy: text("marked_by")
      .notNull()
      .references(() => user.id),
    markedAt: timestamp("marked_at").notNull(),
  },
  (table) => [
    uniqueIndex("orientation_completion_user_event").on(
      table.userId,
      table.eventId,
    ),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id),
    subjectId: text("subject_id")
      .notNull()
      .references(() => user.id),
    action: text("action", {
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
    changedFields: text("changed_fields", { mode: "json" }).$type<string[]>(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("audit_log_subject_time").on(table.subjectId, table.createdAt),
  ],
);

export const eventAudit = sqliteTable(
  "event_audit",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => event.id),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id),
    action: text("action").notNull(),
    changedFields: text("changed_fields", { mode: "json" }).$type<string[]>(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("event_audit_time").on(table.eventId, table.createdAt)],
);

export const eventNotification = sqliteTable(
  "event_notification",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    // Freeze the sending origin across retries on previews sharing one D1.
    deliveryOrigin: text("delivery_origin"),
    status: text("status", { enum: ["pending", "sending", "sent", "local"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until"),
    createdAt: timestamp("created_at").notNull(),
    sentAt: timestamp("sent_at"),
  },
  (table) => [
    index("event_notification_pending").on(table.status, table.createdAt),
    index("event_notification_operation").on(table.operationId),
    check(
      "event_notification_status",
      sql`${table.status} IN ('pending','sending','sent','local')`,
    ),
  ],
);

export const organizerBootstrap = sqliteTable(
  "organizer_bootstrap",
  {
    id: integer("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [check("organizer_bootstrap_once", sql`${table.id} = 1`)],
);
