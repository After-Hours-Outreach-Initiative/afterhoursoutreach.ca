import { sampleProfileFixtures } from "./sample-profile-fixtures";
import { unchangedSampleProfileSql } from "./unchanged-sample-profile";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

// These are complete, known historical seed identities, not a name/email-prefix
// heuristic. Organizers and all broader automated fixtures stay untouched.
const retiredSamples = [
  ["applied", "casey", false, false, "none"],
  ["awaiting-review", "casey", true, false, "none"],
  ["accepted", "alex", true, true, "none"],
  ["orientation-booked", "alex", true, true, "booked"],
  ["orientation-completed", "alex", true, true, "completed"],
  ["medic-orientee", "dana", true, true, "none"],
  ["medic-new-volunteer", "dana", true, true, "none"],
  ["patrol", "alex", true, true, "completed"],
  ["medic", "dana", true, true, "completed"],
] as const;

/** Any activity outside the original seed is saved work, including browser drafts. */
function noSavedActivity(now: number) {
  const references = [
    ["application_draft", "user_id"],
    ["application_draft_generation", "user_id"],
    ["two_factor", "user_id"],
    ["discord_link", "user_id"],
    ["discord_oauth", "user_id"],
    ["discord_requirement", "user_id"],
    ["event", "created_by"],
    ["patrol_series", "created_by"],
    ["patrol_series_audit", "actor_id"],
    ["event_audit", "actor_id"],
    ["event_notification", "user_id"],
    ["application_submission_notification", "user_id"],
    ["medic_certification_notification", "user_id"],
    ["organizer_bootstrap", "user_id"],
    ["orientation_completion", "marked_by"],
    ["audit_log", "actor_id"],
    ["volunteer_status", "approved_by"],
  ];
  return `(${references.map(([table, column]) => `NOT EXISTS(SELECT 1 FROM ${table} WHERE ${column}=u.id)`).join(" AND ")}
    AND NOT EXISTS(SELECT 1 FROM session WHERE user_id=u.id AND expires_at>${now}))`;
}

/** Small read-only inventory queries, reused as guards on every cleanup write. */
export function localAccountCleanupCandidates(now = Date.now()) {
  const samples = sampleProfileFixtures("local", now);
  const manual = retiredSamples.map(
    ([key, sampleKey, naloxone, approved, orientation]) => {
      const person = samples.find(({ key }) => key === sampleKey)!;
      const patrol = key === "patrol" || key === "medic";
      const id = quote(`local-account-user-${key}`);
      const expiry =
        sampleKey === "dana"
          ? "date(v.updated_at/1000.0, 'unixepoch', '+2 years')"
          : undefined;
      return `SELECT u.id FROM user u JOIN profile p ON p.user_id=u.id JOIN volunteer_status v ON v.user_id=u.id
        WHERE u.id=${id} AND u.email=${quote(`${key}.local@example.org`)} AND u.name=${quote(person.name)}
        AND u.role='volunteer' AND u.email_verified=1 AND u.two_factor_enabled=0 AND u.deleted_at IS NULL AND u.image IS NULL
        AND u.updated_at=v.updated_at AND u.created_at=p.registered_at-86400000 AND v.updated_at=p.registered_at+1209600000
        AND v.active=1 AND v.registration_approved=${Number(approved)} AND v.patrol_approved=${Number(patrol)}
        AND v.application_rejection_reason IS NULL
        AND ${patrol ? "v.approved_by='local-account-user-organizer' AND v.approved_at=v.updated_at-1036800000" : "v.approved_by IS NULL AND v.approved_at IS NULL"}
        AND ${naloxone ? "p.naloxone_completed_at=p.registered_at+86400000" : "p.naloxone_completed_at IS NULL"}
        AND ${unchangedSampleProfileSql(person, expiry, true)} AND ${noSavedActivity(now)}
        AND NOT EXISTS(SELECT 1 FROM account WHERE user_id=u.id)
        AND NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.subject_id=u.id AND NOT
          (a.id=${quote(`local-account-approval-${key}`)} AND a.actor_id='local-account-user-organizer'
          AND a.action='approval_changed' AND a.created_at=v.updated_at-1036800000
          AND a.changed_fields=${quote(JSON.stringify(patrol ? ["applicationApproved", "patrolApproved"] : ["applicationApproved"]))}))
        AND NOT EXISTS(SELECT 1 FROM signup s LEFT JOIN event e ON e.id=s.event_id WHERE s.user_id=u.id AND NOT
          (${orientation !== "none" ? 1 : 0}=1 AND s.id=${quote(`local-account-signup-${key}`)} AND s.status='confirmed'
          AND s.created_at=s.updated_at AND e.id=${quote(`local-account-event-${orientation === "booked" ? "orientation" : "past-orientation"}`)}
          AND e.created_at=v.updated_at AND e.updated_at=e.created_at AND e.cancelled_at IS NULL
          AND coalesce(e.includes_orientation,e.type='orientation')=1
          AND s.created_at=${orientation === "booked" ? "v.updated_at" : "e.starts_at-86400000"}))
        AND NOT EXISTS(SELECT 1 FROM orientation_completion o JOIN event e ON e.id=o.event_id WHERE o.user_id=u.id AND NOT
          (${orientation === "completed" ? 1 : 0}=1 AND o.id=${quote(`local-account-completion-${key}`)}
          AND e.id='local-account-event-past-orientation' AND o.marked_by='local-account-user-organizer'
          AND o.marked_at=e.starts_at))`;
    },
  );
  const emptyApplications = `SELECT u.id FROM user u WHERE u.role='volunteer' AND u.name='New application'
    AND length(u.id)=54 AND substr(u.id,1,18)='local-application-'
    AND substr(u.id,19) NOT GLOB '*[^0-9a-f-]*'
    AND u.email=u.id||'@example.invalid' AND u.created_at=u.updated_at
    AND u.deleted_at IS NULL AND u.image IS NULL AND u.email_verified=1 AND u.two_factor_enabled=0
    AND EXISTS(SELECT 1 FROM account a WHERE a.user_id=u.id AND a.account_id=u.id AND a.provider_id='local-development-application'
      AND a.created_at=u.created_at AND a.updated_at=a.created_at
      AND a.password IS NULL AND a.access_token IS NULL AND a.refresh_token IS NULL AND a.id_token IS NULL)
    AND (SELECT count(*) FROM account WHERE user_id=u.id)=1
    AND NOT EXISTS(SELECT 1 FROM profile WHERE user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM volunteer_status WHERE user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM signup WHERE user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM orientation_completion WHERE user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM audit_log WHERE subject_id=u.id)
    AND ${noSavedActivity(now)}`;
  // Keep each identity separate: D1 has tighter expression/compound-query limits.
  return [...manual, emptyApplications];
}

/** Never resets accounts, rewrites snapshots, or removes shared event records. */
export function localAccountCleanup(now = Date.now()) {
  return localAccountCleanupCandidates(now).flatMap((candidates) =>
    ["orientation_completion", "signup", "audit_log", "user"].map(
      (table) =>
        `DELETE FROM ${table} WHERE ${table === "user" ? "id" : table === "audit_log" ? "subject_id" : "user_id"} IN (${candidates})`,
    ),
  );
}
