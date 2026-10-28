import { z } from "zod";
import {
  accessRegistrationCancelledTemplate,
  roleChangedEmail,
  volunteerAccessEmail,
} from "../../data/email-templates";
import { emailTextSql } from "./email-text";
import {
  requireOrganizer,
  writePermission,
  permissionValues,
  type Actor,
} from "./access";
import {
  normalizeCertifications,
  normalizeTrainingAnswers,
  type ApplicationAnswers,
  type SubmittedApplication,
} from "../../data/application";
import { RequestError } from "../http";
import { databaseWriteError } from "./errors";
import {
  includesOrientationSql,
  nowMsSql,
  profileDisplayNameSql,
  profileFullNameSql,
} from "./sql";
import type { VolunteerApprovalFilter } from "../../data/volunteer-list";

export interface VolunteerRow {
  id: string;
  name: string;
  role: "volunteer" | "organizer";
  active: number;
  applicationApproved: number;
  patrolApproved: number;
  updatedAt: number;
  twoFactorEnabled: number;
  orientations: number;
}
export const volunteerPageSize = 50;

export async function listVolunteers(
  db: Env["DB"],
  actor: Actor,
  search = "",
  offset = 0,
  approval: VolunteerApprovalFilter = "all",
) {
  requireOrganizer(actor);
  // A profile is created only on submission; private drafts never enter either
  // query. Both filter counts respect search, but not approval or pagination.
  const applicantsSql = `FROM user u
      JOIN profile p ON p.user_id = u.id
      JOIN volunteer_status v ON v.user_id = u.id
      WHERE instr(lower(${profileDisplayNameSql} || ' ' || ${profileFullNameSql}), lower(?)) > 0
        AND u.deleted_at IS NULL`;
  const query = search.slice(0, 100);
  const [rows, counts] = (await db.batch([
    db
      .prepare(
        `SELECT u.id, ${profileDisplayNameSql} AS name, u.role, u.two_factor_enabled AS twoFactorEnabled,
        v.active, v.registration_approved AS applicationApproved, v.patrol_approved AS patrolApproved, v.updated_at AS updatedAt,
        (SELECT count(*) FROM orientation_completion o WHERE o.user_id = u.id) AS orientations
      ${applicantsSql}
        AND (? = 'all' OR v.registration_approved = 0)
      ORDER BY v.registration_approved, name, u.id
      LIMIT ? OFFSET ?`,
      )
      .bind(query, approval, volunteerPageSize + 1, offset),
    db
      .prepare(
        `SELECT count(*) AS allApplicantsCount,
          count(CASE WHEN v.registration_approved = 0 THEN 1 END) AS awaitingApprovalCount
        ${applicantsSql}`,
      )
      .bind(query),
  ])) as [
    D1Result<VolunteerRow>,
    D1Result<{ allApplicantsCount: number; awaitingApprovalCount: number }>,
  ];
  return {
    rows: rows.results.slice(0, volunteerPageSize),
    hasMore: rows.results.length > volunteerPageSize,
    allApplicantsCount: Number(counts.results[0]?.allApplicantsCount ?? 0),
    awaitingApprovalCount: Number(
      counts.results[0]?.awaitingApprovalCount ?? 0,
    ),
  };
}

export function findVolunteer(db: Env["DB"], actor: Actor, userId: string) {
  requireOrganizer(actor);
  return db
    .prepare(
      `SELECT u.id, ${profileDisplayNameSql} AS name, u.role, u.two_factor_enabled AS twoFactorEnabled,
        v.active, v.registration_approved AS applicationApproved, v.patrol_approved AS patrolApproved, v.updated_at AS updatedAt,
        (SELECT count(*) FROM orientation_completion WHERE user_id=u.id) AS orientations
      FROM user u JOIN profile p ON p.user_id=u.id
      JOIN volunteer_status v ON v.user_id=u.id WHERE u.id=? AND u.deleted_at IS NULL`,
    )
    .bind(userId)
    .first<VolunteerRow>();
}

/** Log before reading sensitive answers; failed logging means no disclosure. */
export async function viewVolunteerProfile(
  db: Env["DB"],
  actor: Actor,
  userId: string,
) {
  requireOrganizer(actor);
  const subject = await db
    .prepare(
      "SELECT user_id FROM profile p JOIN user u ON u.id=p.user_id WHERE p.user_id=? AND u.deleted_at IS NULL",
    )
    .bind(userId)
    .first();
  if (!subject) throw new RequestError(404, "Volunteer not found.");
  const accessId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_log (id, actor_id, subject_id, action, created_at)
        SELECT ?, ?, ?, 'profile_viewed', ?
        WHERE ${writePermission(true)}`,
      )
      .bind(accessId, actor.id, userId, Date.now(), ...permissionValues(actor)),
    db
      .prepare(
        `SELECT coalesce(first_name, '') AS firstName, coalesce(middle_names, '') AS middleNames,
          coalesce(last_name, '') AS lastName, preferred_name AS preferredName,
          coalesce(pronouns, '') AS pronouns,
          phone, birth_date AS birthDate,
          emergency_contact_name AS emergencyName,
          emergency_contact_phone AS emergencyPhone,
          emergency_contact_relationship AS emergencyRelationship,
          heard_about_us AS heardAboutUs,
          heard_about_us_sources AS heardAboutUsSources,
          coalesce(heard_about_us_other, '') AS heardAboutUsOther,
          motivation, teams,
          medical_certification AS certification, training_experience AS experience,
          medical_certifications AS certifications,
          relevant_training AS training, other_training AS otherTraining,
          expired_first_aid_details AS expiredFirstAidDetails,
          crisis_intervention_details AS crisisInterventionDetails,
          relevant_experience AS relevantExperience, other_experience AS otherExperience,
          coalesce(medical_certification_expiry, '') AS certificationExpiry,
          coalesce(medical_conditions, '') AS medicalConditions,
          u.email, p.registered_at AS submittedAt,
          p.code_of_conduct_version AS codeOfConductVersion,
          p.code_of_conduct_accepted_at AS codeOfConductAcceptedAt,
          p.naloxone_completed_at AS naloxoneCompletedAt,
          p.submitted_application AS submission
        FROM profile p JOIN user u ON u.id = p.user_id
        WHERE p.user_id = ? AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
      )
      .bind(userId, accessId),
    // approved_by belongs to patrol approval. The latest application-status
    // audit identifies the current approver only while the application is approved.
    // Historical approvals without such an audit deliberately stay unattributed.
    db
      .prepare(
        `SELECT approver.id, approver.name, approver.email, a.created_at AS approvedAt
        FROM audit_log a JOIN user approver ON approver.id=a.actor_id
        JOIN volunteer_status v ON v.user_id=a.subject_id
        WHERE a.subject_id=? AND v.registration_approved=1
          AND a.action='approval_changed'
          AND EXISTS (SELECT 1 FROM json_each(a.changed_fields)
            WHERE value IN ('applicationApproved', 'registrationApproved'))
          AND EXISTS (SELECT 1 FROM audit_log WHERE id=?)
        ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
      )
      .bind(userId, accessId),
  ]);
  if (!results[0].meta.changes)
    throw new RequestError(
      403,
      "Organizer authorization changed. Sign in again.",
    );
  const row = results[1].results[0] as
    | (Omit<
        ApplicationAnswers,
        | "teams"
        | "certifications"
        | "training"
        | "relevantExperience"
        | "heardAboutUsSources"
      > & {
        teams: string;
        certifications: string;
        training: string;
        relevantExperience: string | null;
        heardAboutUsSources: string | null;
        email: string;
        submittedAt: number;
        codeOfConductVersion: string | null;
        codeOfConductAcceptedAt: number | null;
        naloxoneCompletedAt: number | null;
        submission: string | null;
      })
    | undefined;
  if (!row) return null;
  const {
    email,
    submittedAt,
    codeOfConductVersion,
    codeOfConductAcceptedAt,
    naloxoneCompletedAt,
    submission,
    ...answers
  } = row;
  const applicationApprovedBy = results[2].results[0] as
    { id: string; name: string; email: string; approvedAt: number } | undefined;
  const sources = row.heardAboutUsSources
    ? (JSON.parse(row.heardAboutUsSources) as string[])
    : [];
  return {
    // Read the original only through the same audited, authorized disclosure.
    submission: submission
      ? (JSON.parse(submission) as SubmittedApplication)
      : null,
    answers: {
      ...answers,
      heardAboutUsSources: sources,
      heardAboutUsOther: sources.includes("other") ? row.heardAboutUsOther : "",
      teams: JSON.parse(row.teams) as string[],
      certifications: normalizeCertifications(
        JSON.parse(row.certifications) as string[],
      ),
      ...normalizeTrainingAnswers({
        training: JSON.parse(row.training) as string[],
        otherTraining: row.otherTraining,
        expiredFirstAidDetails: row.expiredFirstAidDetails,
        crisisInterventionDetails: row.crisisInterventionDetails,
        relevantExperience: row.relevantExperience
          ? (JSON.parse(row.relevantExperience) as string[])
          : null,
        otherExperience: row.otherExperience,
      }),
    } satisfies ApplicationAnswers,
    email,
    applicationApprovedBy: applicationApprovedBy ?? null,
    submittedAt: new Date(submittedAt).toISOString(),
    naloxoneCompletedAt,
    codeOfConductVersion,
    codeOfConductAcceptedAt:
      codeOfConductAcceptedAt === null
        ? null
        : new Date(codeOfConductAcceptedAt).toISOString(),
  };
}

export const statusSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  version: z.number().int().nonnegative(),
  active: z.boolean(),
  applicationApproved: z.boolean().optional(),
  // Accept older open organizer forms; new clients use applicationApproved.
  registrationApproved: z.boolean().optional(),
  patrolApproved: z.boolean(),
  notify: z.boolean().default(false),
});
export async function setVolunteerStatus(
  db: Env["DB"],
  actor: Actor,
  input: unknown,
) {
  requireOrganizer(actor);
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(400, "Choose a volunteer and their access status.");
  const { userId, version, active, patrolApproved, notify } = parsed.data;
  const old = await db
    .prepare(
      `SELECT active, registration_approved AS applicationApproved, patrol_approved AS patrolApproved
      FROM volunteer_status
      WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{
      active: number;
      applicationApproved: number;
      patrolApproved: number;
    }>();
  if (!old) throw new RequestError(404, "Volunteer not found.");
  if (
    parsed.data.applicationApproved !== undefined &&
    parsed.data.registrationApproved !== undefined &&
    parsed.data.applicationApproved !== parsed.data.registrationApproved
  )
    throw new RequestError(400, "Choose one application approval status.");
  // The SQL column keeps its legacy name; omission preserves existing approval.
  const applicationApproved =
    parsed.data.applicationApproved ??
    parsed.data.registrationApproved ??
    Boolean(old.applicationApproved);
  if (applicationApproved && !old.applicationApproved) {
    const blocked = await db
      .prepare(
        // Keep the Naloxone prerequisite and legacy exemptions while Discord is paused.
        `SELECT 1 FROM discord_requirement r
      LEFT JOIN profile p ON p.user_id=r.user_id
      /* LEFT JOIN discord_link d ON d.user_id=r.user_id */
      WHERE r.user_id=? AND (p.naloxone_completed_at IS NULL
        /* OR d.completed_at IS NULL OR d.member_verified_at IS NULL */)`,
      )
      .bind(userId)
      .first();
    if (blocked)
      throw new RequestError(
        409,
        // "The applicant must complete Naloxone 101 and connect Discord with verified server membership before approval.",
        "The applicant must complete Naloxone 101 before approval.",
      );
  }
  const fields = [
    old.active !== Number(active) ? "active" : "",
    old.applicationApproved !== Number(applicationApproved)
      ? "applicationApproved"
      : "",
    old.patrolApproved !== Number(patrolApproved) ? "patrolApproved" : "",
  ].filter(Boolean);
  if (!fields.length)
    return { operation: crypto.randomUUID(), message: "No access changes." };
  const email = volunteerAccessEmail(
    { active, applicationApproved, patrolApproved },
    fields.includes("applicationApproved"),
    actor.name,
  );
  const operation = crypto.randomUUID();
  const now = Math.max(Date.now(), version + 1);
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE volunteer_status
          SET active = ?,
              registration_approved = ?,
              patrol_approved = ?,
              approved_by = CASE WHEN patrol_approved = ? THEN approved_by ELSE ? END,
              approved_at = CASE WHEN patrol_approved = ? THEN approved_at ELSE ? END,
              updated_at = ?
          WHERE user_id = ?
            AND updated_at = ?
            AND (registration_approved=1 OR ?=0 OR NOT EXISTS(SELECT 1 FROM discord_requirement WHERE user_id=volunteer_status.user_id)
              OR EXISTS(SELECT 1 FROM profile p /* JOIN discord_link d ON d.user_id=p.user_id */
                WHERE p.user_id=volunteer_status.user_id AND p.naloxone_completed_at IS NOT NULL
                  /* AND d.completed_at IS NOT NULL AND d.member_verified_at IS NOT NULL */))
            AND ${writePermission(true)}`,
        )
        .bind(
          Number(active),
          Number(applicationApproved),
          Number(patrolApproved),
          Number(patrolApproved),
          patrolApproved ? actor.id : null,
          Number(patrolApproved),
          patrolApproved ? now : null,
          now,
          userId,
          version,
          Number(applicationApproved),
          ...permissionValues(actor),
        ),
      db
        .prepare(
          `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
          SELECT ?, ?, ?, ?, ?, ?
          WHERE changes() = 1`,
        )
        .bind(
          operation,
          actor.id,
          userId,
          fields.includes("patrolApproved") ||
            fields.includes("applicationApproved")
            ? "approval_changed"
            : "active_changed",
          JSON.stringify(fields),
          now,
        ),
      // Only queue opted-in mail, before cancellation loses the original roster.
      db
        .prepare(
          `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at, delivery_to)
          SELECT lower(hex(randomblob(16))), ?, s.user_id,
            ?, ${emailTextSql(accessRegistrationCancelledTemplate.text, {
              orientation: `CASE WHEN ${includesOrientationSql()} THEN ' (includes orientation)' ELSE '' END`,
              meetingPoint: "e.meeting_point",
            })}, ?, u.email
          FROM signup s
          JOIN event e ON e.id = s.event_id
          JOIN user u ON u.id=s.user_id AND u.email_verified=1
          WHERE s.user_id = ?
            AND s.status = 'confirmed'
            AND e.starts_at > ?
            AND (? = 0 OR (? = 0 AND EXISTS(SELECT 1 FROM user WHERE id = s.user_id AND role != 'organizer')) OR (? = 0 AND NOT ${includesOrientationSql()}))
            AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?)
            AND ? = 1`,
        )
        .bind(
          operation,
          accessRegistrationCancelledTemplate.subject,
          now,
          userId,
          now,
          Number(active),
          Number(applicationApproved),
          Number(patrolApproved),
          operation,
          Number(notify),
        ),
      db
        .prepare(
          `UPDATE signup
          SET status = 'cancelled', updated_at = ?
          WHERE user_id = ?
            AND status = 'confirmed'
            AND event_id IN(
              SELECT e.id FROM event e
              WHERE e.starts_at > ? AND (? = 0 OR (? = 0 AND EXISTS(SELECT 1 FROM user WHERE id = signup.user_id AND role != 'organizer')) OR (? = 0 AND NOT ${includesOrientationSql()}))
            )
            AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(
          now,
          userId,
          now,
          Number(active),
          Number(applicationApproved),
          Number(patrolApproved),
          operation,
        ),
      db
        .prepare(
          `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at, delivery_to)
          SELECT ?, ?, ?, ?, ?, ?, email FROM user
          WHERE id=? AND email_verified=1 AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?) AND ? = 1`,
        )
        .bind(
          crypto.randomUUID(),
          operation,
          userId,
          email.subject,
          email.text,
          now,
          userId,
          operation,
          Number(notify),
        ),
    ]);
    if (!results[0].meta.changes)
      throw new RequestError(
        409,
        "This volunteer's status changed. Reload before saving.",
      );
    return { operation, message: "Volunteer access saved." };
  } catch (error) {
    return databaseWriteError(error);
  }
}

export async function setRole(
  db: Env["DB"],
  actor: Actor,
  userId: string,
  role: "volunteer" | "organizer",
  notify = false,
) {
  requireOrganizer(actor);
  const target = await db
    .prepare(
      `SELECT u.role, u.email_verified AS verified, v.active, v.registration_approved AS applicationApproved
      FROM user u
      JOIN profile p ON p.user_id = u.id
      JOIN volunteer_status v ON v.user_id = u.id
      WHERE u.id = ?`,
    )
    .bind(userId)
    .first<{
      role: string;
      verified: number;
      active: number;
      applicationApproved: number;
    }>();
  if (!target) throw new RequestError(404, "Volunteer applicant not found.");
  if (target.role === role)
    return { operation: crypto.randomUUID(), message: "Role is unchanged." };
  const email = roleChangedEmail(role);
  if (
    role === "organizer" &&
    (!target.verified || !target.active || !target.applicationApproved)
  )
    throw new RequestError(
      409,
      "New organizers need a verified email and an active, approved application first.",
    );
  const operation = crypto.randomUUID();
  const now = Date.now();
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE user
          SET role = ?, updated_at = ?
          WHERE id = ?
            AND role = ?
            AND ${writePermission(true)}
            AND (? = 'volunteer' OR (email_verified = 1 AND EXISTS(
              SELECT 1 FROM volunteer_status WHERE user_id = ? AND active = 1 AND registration_approved = 1
            )))`,
        )
        .bind(
          role,
          now,
          userId,
          target.role,
          ...permissionValues(actor),
          role,
          userId,
        ),
      db
        .prepare(
          `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
          SELECT ?, ?, ?, 'role_changed', '["role"]', ?
          WHERE changes() = 1`,
        )
        .bind(operation, actor.id, userId, now),
      db
        .prepare(
          `DELETE FROM session
          WHERE user_id = ? AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(userId, operation),
      db
        .prepare(
          `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at, delivery_to)
          SELECT ?, ?, ?, ?, ?, ?, email FROM user
          WHERE id=? AND email_verified=1 AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?) AND ? = 1`,
        )
        .bind(
          crypto.randomUUID(),
          operation,
          userId,
          email.subject,
          email.text,
          now,
          userId,
          operation,
          Number(notify),
        ),
    ]);
    if (!results[0].meta.changes)
      throw new RequestError(
        409,
        "This account's role changed. Reload the page.",
      );
    return {
      operation,
      message: "Role saved. The volunteer must sign in again.",
    };
  } catch (error) {
    return databaseWriteError(error);
  }
}

export async function completeOrientation(
  db: Env["DB"],
  actor: Actor,
  userId: string,
  eventId: string,
) {
  requireOrganizer(actor);
  const eligible = await db
    .prepare(
      `SELECT e.id
      FROM event e
      JOIN signup s ON s.event_id = e.id
      WHERE e.id = ?
        AND coalesce(e.includes_orientation, e.type = 'orientation')
        AND e.cancelled_at IS NULL
        AND e.starts_at <= ?
        AND s.user_id = ?
        AND s.status = 'confirmed'`,
    )
    .bind(eventId, Date.now(), userId)
    .first();
  if (!eligible)
    throw new RequestError(
      409,
      "Only attendees registered for an orientation that has started can be marked completed.",
    );
  const operation = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO orientation_completion (id, user_id, event_id, marked_by, marked_at)
        SELECT ?, ?, ?, ?, ?
        WHERE ${writePermission(true)}
          AND EXISTS(
            SELECT 1 FROM event e
            JOIN signup s ON s.event_id = e.id
            WHERE e.id = ?
              AND s.user_id = ?
              AND s.status = 'confirmed'
              AND coalesce(e.includes_orientation, e.type = 'orientation')
              AND e.cancelled_at IS NULL
              AND e.starts_at <= ${nowMsSql}
          )
        ON CONFLICT(user_id, event_id) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        eventId,
        actor.id,
        Date.now(),
        ...permissionValues(actor),
        eventId,
        userId,
      ),
    db
      .prepare(
        `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
        SELECT ?, ?, ?, 'orientation_completed', '["orientationCompletion"]', ?
        WHERE changes() = 1`,
      )
      .bind(operation, actor.id, userId, Date.now()),
  ]);
  if (!results[0].meta.changes) {
    const recorded = await db
      .prepare(
        "SELECT id FROM orientation_completion WHERE user_id=? AND event_id=?",
      )
      .bind(userId, eventId)
      .first();
    if (!recorded)
      throw new RequestError(
        409,
        "Attendance or organizer authorization changed. Reload the page.",
      );
  }
  return {
    operation,
    message: "Orientation marked completed.",
  };
}
