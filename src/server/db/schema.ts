import { sql } from "drizzle-orm";
import type { ApplicationDraftAnswers } from "../../data/application-draft";
import type { SubmittedApplication } from "../../data/application";
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
    // Irreversible sign-in deletion; referenced decision/history records remain.
    deleted_at: timestamp(),
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

// Only profiles submitted after this feature is installed receive a requirement.
// Absence deliberately grandfathers existing volunteers, without inventing consent.
export const discordRequirement = sqliteTable("discord_requirement", {
  user_id: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const discordOAuth = sqliteTable("discord_oauth", {
  state_hash: text().primaryKey(),
  user_id: text()
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  session_id: text().notNull(),
  browser_hash: text().notNull(),
  verifier: text().notNull(),
  origin: text().notNull(),
  expires_at: timestamp().notNull(),
});

// The link is also a durable, coalescing outbox. Workers always derive roles
// from live website records; queued payloads never contain stale eligibility.
export const discordLink = sqliteTable(
  "discord_link",
  {
    user_id: text()
      .primaryKey()
      .references(() => user.id),
    discord_id: text().notNull().unique(),
    username: text().notNull(),
    guild_id: text().notNull(),
    consented_at: timestamp().notNull(),
    completed_at: timestamp(),
    member_verified_at: timestamp(),
    observed_roles: text({ mode: "json" }).$type<string[]>(),
    member_ready: integer({ mode: "boolean" }).notNull().default(false),
    checked_at: timestamp(),
    join_token: text(), // AES-GCM ciphertext, discarded after verified membership.
    token_expires_at: timestamp(),
    version: integer().notNull().default(1),
    synced_version: integer().notNull().default(0),
    next_attempt_at: timestamp().notNull(),
    attempts: integer().notNull().default(0),
    last_synced_at: timestamp(),
    last_error: text(), // Fixed public error code only; never provider bodies.
  },
  (table) => [index("discord_link_due").on(table.next_attempt_at)],
);

// One distributed lease for the dedicated bot. Rate-limit cooldowns survive
// crashes and apply across routes, isolates, and scheduled/request invocations.
export const discordWorker = sqliteTable(
  "discord_worker",
  {
    id: integer().primaryKey(),
    lease_token: text(),
    lease_until: timestamp()
      .notNull()
      .default(sql`0`),
    not_before: timestamp()
      .notNull()
      .default(sql`0`),
    request_window: integer().notNull().default(0),
    request_count: integer().notNull().default(0),
  },
  (table) => [check("discord_worker_singleton", sql`${table.id} = 1`)],
);

// A draft is private to its owner and never counts as a submitted profile.
export const applicationDraft = sqliteTable("application_draft", {
  user_id: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  revision: text().notNull(),
  answers: text({ mode: "json" }).$type<ApplicationDraftAnswers>().notNull(),
  updated_at: timestamp().notNull(),
});

// Answer-free tombstones invalidate delayed saves even when no draft row exists.
export const applicationDraftGeneration = sqliteTable(
  "application_draft_generation",
  {
    user_id: text()
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    generation: text().notNull(),
  },
);

export const profile = sqliteTable("profile", {
  user_id: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  // Nullable for legacy profiles: never infer components from the old combined answer.
  first_name: text(),
  middle_names: text(),
  last_name: text(),
  // Legacy profiles retain their original full-or-preferred-name answer here.
  // New profiles may leave this empty and use their full name for display.
  preferred_name: text().notNull(),
  pronouns: text(),
  phone: text().notNull(),
  // Birth dates are calendar dates (YYYY-MM-DD), not UTC timestamps.
  birth_date: text().notNull(),
  emergency_contact_name: text().notNull(),
  emergency_contact_phone: text().notNull(),
  emergency_contact_relationship: text().notNull(),
  heard_about_us: text().notNull(),
  // Null on legacy profiles: keep the original free-text answer above untouched.
  heard_about_us_sources: text({ mode: "json" }).$type<string[]>(),
  heard_about_us_other: text(),
  motivation: text().notNull(),
  teams: text({ mode: "json" }).$type<string[]>().notNull(),
  medical_certification: text().notNull(),
  medical_certifications: text({ mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  medical_certification_expiry: text(),
  training_experience: text().notNull(),
  relevant_training: text({ mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  other_training: text().notNull().default(""),
  expired_first_aid_details: text().notNull().default(""),
  crisis_intervention_details: text().notNull().default(""),
  // Null identifies legacy combined training/experience answers until their next save.
  relevant_experience: text({ mode: "json" }).$type<string[]>(),
  other_experience: text().notNull().default(""),
  medical_conditions: text(),
  // Nullable for existing/synthetic profiles; never invent an acknowledgement.
  code_of_conduct_version: text(),
  code_of_conduct_accepted_at: timestamp(),
  // Insert-only submission snapshot. Null means the original was not captured.
  submitted_application: text({ mode: "json" }).$type<SubmittedApplication>(),
  // Separate, owner-reported course confirmation, never inferred from legacy training.
  naloxone_completed_at: timestamp(),
  // Legacy SQL name: when the volunteer application was submitted.
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
    // Legacy SQL name, mapped to applicationApproved outside the storage layer.
    registration_approved: integer({ mode: "boolean" })
      .notNull()
      .default(false),
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

// A series is only a generation template, never a registration destination.
export const patrolSeries = sqliteTable(
  "patrol_series",
  {
    id: text().primaryKey(),
    first_date: text().notNull(),
    local_time: text().notNull(),
    interval_weeks: integer().notNull(),
    end_date: text(),
    // Exclusive, permanent stop boundary (also represents stopping before first).
    stopped_from: text(),
    time_zone: text().notNull().default("America/Vancouver"),
    meeting_point: text().notNull(),
    meeting_point_url: text(),
    spots: integer().notNull(),
    open: integer({ mode: "boolean" }).notNull().default(true),
    hidden: integer({ mode: "boolean" }).notNull().default(false),
    includes_orientation: integer({ mode: "boolean" }).notNull().default(false),
    // Exclusive instant of the first unmaterialized future nominal occurrence.
    // Signup fails closed beyond this frontier, even if maintenance is delayed.
    generation_until: timestamp()
      .notNull()
      .default(sql`0`),
    created_by: text()
      .notNull()
      .references(() => user.id),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  (table) => [
    check(
      "patrol_series_interval",
      sql`${table.interval_weeks} BETWEEN 1 AND 52`,
    ),
    check("patrol_series_spots", sql`${table.spots} BETWEEN 1 AND 100`),
    check("patrol_series_zone", sql`${table.time_zone} = 'America/Vancouver'`),
    check(
      "patrol_series_end",
      sql`${table.end_date} IS NULL OR ${table.end_date} >= ${table.first_date}`,
    ),
    check("patrol_series_open_boolean", sql`${table.open} IN (0, 1)`),
    check("patrol_series_hidden_boolean", sql`${table.hidden} IN (0, 1)`),
  ],
);

export const patrolSeriesAudit = sqliteTable(
  "patrol_series_audit",
  {
    id: text().primaryKey(),
    series_id: text()
      .notNull()
      .references(() => patrolSeries.id),
    actor_id: text()
      .notNull()
      .references(() => user.id),
    action: text().notNull(),
    changed_fields: text({ mode: "json" }).$type<string[]>().notNull(),
    created_at: timestamp().notNull(),
  },
  (table) => [
    index("patrol_series_audit_time").on(table.series_id, table.created_at),
  ],
);

// Effective-date templates leave the nominal cadence and occurrence IDs intact.
// A later this-and-future edit replaces subsequent templates, not exceptions.
export const patrolSeriesTemplate = sqliteTable(
  "patrol_series_template",
  {
    id: text().primaryKey(),
    series_id: text()
      .notNull()
      .references(() => patrolSeries.id),
    effective_date: text().notNull(),
    local_time: text().notNull(),
    day_offset: integer().notNull().default(0),
    meeting_point: text().notNull(),
    meeting_point_url: text(),
    spots: integer().notNull(),
    open: integer({ mode: "boolean" }).notNull(),
    hidden: integer({ mode: "boolean" }).notNull(),
    includes_orientation: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("patrol_series_template_date").on(
      table.series_id,
      table.effective_date,
    ),
    check(
      "patrol_template_offset",
      sql`${table.day_offset} BETWEEN -366 AND 366`,
    ),
    check("patrol_template_spots", sql`${table.spots} BETWEEN 1 AND 100`),
    check("patrol_template_open", sql`${table.open} IN (0, 1)`),
    check("patrol_template_hidden", sql`${table.hidden} IN (0, 1)`),
  ],
);

export const event = sqliteTable(
  "event",
  {
    id: text().primaryKey(),
    // Legacy storage only: every event is a patrol. Null overrides below inherit
    // this historical orientation flag without rewriting events or their history.
    type: text({ enum: ["patrol", "orientation"] }).notNull(),
    includes_orientation: integer({ mode: "boolean" }),
    series_id: text().references(() => patrolSeries.id),
    // Immutable nominal local date, independent of starts_at exception edits.
    occurrence_date: text(),
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
    check(
      "event_series_occurrence",
      sql`(${table.series_id} IS NULL AND ${table.occurrence_date} IS NULL) OR (${table.series_id} IS NOT NULL AND ${table.occurrence_date} IS NOT NULL AND ${table.type} = 'patrol')`,
    ),
    uniqueIndex("event_series_occurrence_unique").on(
      table.series_id,
      table.occurrence_date,
    ),
    index("event_series_start").on(table.series_id, table.starts_at, table.id),
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

// Immutable provider requests: a retry must replay the same batch, not regroup it.
export const eventNotificationBatch = sqliteTable(
  "event_notification_batch",
  {
    id: text().primaryKey(),
    operation_id: text().notNull(),
    payload: text().notNull(),
    status: text({ enum: ["pending", "sending", "sent", "local", "cancelled"] })
      .notNull()
      .default("pending"),
    outcome: text({ enum: ["failed", "unconfirmed"] }),
    budget_window: timestamp(),
    lease_token: text(),
    lease_until: timestamp(),
    created_at: timestamp().notNull(),
  },
  (table) => [
    index("event_notification_batch_operation").on(table.operation_id),
  ],
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
    // Null on legacy records, which must not be swept into a new send action.
    delivery_to: text(),
    batch_id: text().references(() => eventNotificationBatch.id),
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

// Keep terminal rows as the delivery ledger for each certification renewal cycle.
export const medicCertificationNotification = sqliteTable(
  "medic_certification_notification",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiry: text().notNull(),
    kind: text({ enum: ["warning", "expired"] }).notNull(),
    status: text({
      enum: ["pending", "sending", "sent", "expired", "cancelled"],
    })
      .notNull()
      .default("pending"),
    // Exact Resend request, frozen on first attempt; cleared on terminal states.
    delivery_payload: text(),
    first_attempt_at: timestamp(),
    attempts: integer().notNull().default(0),
    lease_token: text(),
    lease_until: timestamp(),
    created_at: timestamp().notNull(),
    sent_at: timestamp(),
  },
  (table) => [
    uniqueIndex("medic_notification_cycle").on(
      table.user_id,
      table.expiry,
      table.kind,
    ),
    index("medic_notification_pending").on(table.status, table.created_at),
    check(
      "medic_notification_kind",
      sql`${table.kind} IN ('warning','expired')`,
    ),
    check(
      "medic_notification_status",
      sql`${table.status} IN ('pending','sending','sent','expired','cancelled')`,
    ),
  ],
);

// One immutable request per first submission and fixed organizer mailbox. No
// recipient account is required; only name/time/review metadata is copied.
export const applicationSubmissionNotification = sqliteTable(
  "application_submission_notification",
  {
    id: text().primaryKey(),
    operation_id: text().notNull(),
    user_id: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    recipient: text().notNull(),
    mode: text({ enum: ["production", "local", "preview"] }).notNull(),
    // Frozen at submission; previews retain only a suppressed ledger entry.
    payload: text(),
    status: text({
      enum: ["pending", "sending", "sent", "local", "suppressed", "expired"],
    })
      .notNull()
      .default("pending"),
    outcome: text({ enum: ["failed", "unconfirmed"] }),
    first_attempt_at: timestamp(),
    next_attempt_at: timestamp().notNull(),
    attempts: integer().notNull().default(0),
    budget_window: timestamp(),
    lease_token: text(),
    lease_until: timestamp(),
    created_at: timestamp().notNull(),
    sent_at: timestamp(),
  },
  (table) => [
    uniqueIndex("application_submission_recipient").on(
      table.user_id,
      table.recipient,
    ),
    index("application_submission_pending").on(
      table.mode,
      table.status,
      table.next_attempt_at,
    ),
    index("application_submission_operation").on(table.operation_id),
    check(
      "application_submission_recipient_fixed",
      sql`${table.recipient} IN ('ivan.zheng@afterhoursoutreach.ca','info@afterhoursoutreach.ca','molina.dewilde@afterhoursoutreach.ca')`,
    ),
    check(
      "application_submission_mode",
      sql`${table.mode} IN ('production','local','preview')`,
    ),
    check(
      "application_submission_status",
      sql`${table.status} IN ('pending','sending','sent','local','suppressed','expired')`,
    ),
    check(
      "application_submission_preview_suppressed",
      sql`${table.mode} != 'preview' OR (${table.status} = 'suppressed' AND ${table.payload} IS NULL)`,
    ),
  ],
);
