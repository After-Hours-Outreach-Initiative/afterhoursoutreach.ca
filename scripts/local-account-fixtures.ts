import { vancouverInput, vancouverInstant } from "../src/data/event-time";
import { applicationDraftAnswersSchema } from "../src/data/application-draft";
import { localAccountUserId, manualAccountPresets } from "../src/dev/accounts";
import { approvedMedicSql, newVolunteerSql } from "../src/server/db/sql";
import { manualProfileFixture } from "./manual-profile-fixtures";
import { unchangedSampleProfileSql } from "./unchanged-sample-profile";
import { localAccountCleanup } from "./local-account-cleanup";
import {
  sampleProfileFixtures,
  sampleProfileStatement,
  sampleDiscordExemption,
} from "./sample-profile-fixtures";

export { localAccountUserId } from "../src/dev/accounts";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const eventId = (key: string) => `local-account-v2-event-${key}`;

/** Manual View as personas, separate from the broader automated-test fixtures. */
export function localAccountFixtures(now = Date.now()) {
  const statements: string[] = localAccountCleanup(now);
  const people = sampleProfileFixtures("local", now);
  const organizer = quote(localAccountUserId("organizer"));
  const submittedAt = now - 14 * 86_400_000;
  const naloxoneAt = now - 13 * 86_400_000;
  const approvedAt = now - 12 * 86_400_000;
  // Create every identity first: patrol approvals must reference a real organizer.
  for (const preset of manualAccountPresets) {
    const person = manualProfileFixture(preset, now);
    statements.push(`INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (${quote(preset.id)}, ${quote(person.name)}, ${quote(person.email)}, 1, ${quote(preset.role)}, ${now - 15 * 86_400_000}, ${now})
      ON CONFLICT(id) DO NOTHING`);
    if (preset.draft) {
      const answers = applicationDraftAnswersSchema.parse({
        firstName: person.answers.firstName,
        lastName: person.answers.lastName,
        phone: person.answers.phone,
        teams: person.answers.teams,
      });
      statements.push(`INSERT INTO application_draft (user_id, version, revision, answers, updated_at)
        SELECT ${quote(preset.id)}, 1, 'e261e220-743b-4d91-b5cd-5966407e1396', ${quote(JSON.stringify(answers))}, ${now}
        WHERE changes()=1 AND EXISTS (SELECT 1 FROM user WHERE id=${quote(preset.id)} AND email=${quote(person.email)})
        AND NOT EXISTS (SELECT 1 FROM profile WHERE user_id=${quote(preset.id)})
        AND NOT EXISTS (SELECT 1 FROM application_draft_generation WHERE user_id=${quote(preset.id)})
        ON CONFLICT(user_id) DO NOTHING`);
    }
  }
  for (const preset of manualAccountPresets) {
    const id = quote(preset.id);
    const person = manualProfileFixture(preset, now);
    const email = person.email;
    const identity = `EXISTS (SELECT 1 FROM user WHERE id=${id} AND email=${quote(email)})`;
    if (preset.draft) continue;

    // Upgrade only demonstrably untouched old manual fixtures. Never infer consent
    // or overwrite snapshots, edited answers, approvals, identities or activity.
    const legacy = {
      accepted: ["Accepted", 1, 1],
      inactive: ["Inactive", 0, 0],
      organizer: ["Organizer", 1, 1],
    }[preset.key];
    if (legacy) {
      const repair = quote(`local-account-v2-upgrade-${preset.key}`);
      const oldPerson = {
        ...people.find(({ key }) => key === preset.sampleKey)!,
        email,
      };
      const unchangedProfile = `(${unchangedSampleProfileSql(person)} OR ${unchangedSampleProfileSql(oldPerson)})`;
      statements.push(`INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
        SELECT ${repair}, ${organizer}, ${id}, 'profile_updated', '["naloxoneCompletedAt"]', ${now}
        FROM user u JOIN profile p ON p.user_id=u.id JOIN volunteer_status v ON v.user_id=u.id
        WHERE u.id=${id} AND u.email=${quote(email)} AND u.name=${quote(String(legacy[0]))}
        AND u.role=${quote(preset.role)} AND v.updated_at=p.registered_at
        AND p.naloxone_completed_at IS NULL AND v.active=${legacy[1]} AND v.registration_approved=${legacy[2]}
        AND v.patrol_approved=0 AND ${unchangedProfile}
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE subject_id=${id})
        AND NOT EXISTS (SELECT 1 FROM signup WHERE user_id=${id})
        AND NOT EXISTS (SELECT 1 FROM orientation_completion WHERE user_id=${id})
        AND EXISTS (SELECT 1 FROM user WHERE id=${organizer} AND email='organizer.v2.local@example.org' AND role='organizer')
        ON CONFLICT(id) DO NOTHING`);
      statements.push(`UPDATE profile SET naloxone_completed_at=${now}
        WHERE user_id=${id} AND changes()=1 AND EXISTS (SELECT 1 FROM audit_log WHERE id=${repair})`);
      statements.push(`UPDATE volunteer_status SET registration_approved=1, updated_at=max(${now}, updated_at+1)
        WHERE user_id=${id} AND changes()=1 AND EXISTS (SELECT 1 FROM audit_log WHERE id=${repair})`);
      statements.push(`INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
        SELECT ${quote(`local-account-v2-upgrade-approval-${preset.key}`)}, ${organizer}, ${id}, 'approval_changed', '["applicationApproved"]', ${now}
        WHERE changes()=1 AND EXISTS (SELECT 1 FROM audit_log WHERE id=${repair})`);

      if (preset.key === "organizer") {
        // The earlier Organizer presets had application approval only. Recognize
        // their seed audit/timestamps; never reinstate a manually revoked approval.
        statements.push(`UPDATE volunteer_status SET patrol_approved=1, approved_by=${organizer},
          approved_at=${now}, updated_at=max(${now}, updated_at+1)
          WHERE user_id=${organizer} AND patrol_approved=0 AND approved_by IS NULL AND approved_at IS NULL
          AND EXISTS (SELECT 1 FROM user u JOIN profile p ON p.user_id=u.id
            JOIN volunteer_status v ON v.user_id=u.id
            WHERE u.id=${organizer} AND u.email='organizer.v2.local@example.org' AND u.email_verified=1
            AND u.role='organizer' AND u.name IN ('Organizer', ${quote(person.name)})
            AND v.active=1 AND v.registration_approved=1 AND p.naloxone_completed_at IS NOT NULL
            AND ${unchangedProfile}
            AND EXISTS (SELECT 1 FROM audit_log a WHERE a.subject_id=u.id AND a.actor_id=u.id
              AND a.action='approval_changed' AND a.changed_fields='["applicationApproved"]'
              AND ((a.id='local-account-v2-approval-organizer' AND v.updated_at=a.created_at+${12 * 86_400_000}
                AND p.registered_at=a.created_at-${2 * 86_400_000} AND p.naloxone_completed_at=a.created_at-${86_400_000})
                OR (a.id='local-account-v2-upgrade-approval-organizer' AND v.updated_at=a.created_at
                  AND p.naloxone_completed_at=a.created_at))))
          AND NOT EXISTS (SELECT 1 FROM audit_log WHERE subject_id=${organizer}
            AND action IN ('profile_updated','approval_changed','active_changed','role_changed')
            AND id NOT IN ('local-account-v2-approval-organizer','local-account-v2-upgrade-organizer','local-account-v2-upgrade-approval-organizer'))`);
        statements.push(`INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
          SELECT 'local-account-v2-upgrade-patrol-organizer', ${organizer}, ${organizer},
          'approval_changed', '["patrolApproved"]', ${now} WHERE changes()=1`);
      }
    }

    statements.push(
      sampleProfileStatement(person, submittedAt, {
        naloxoneCompletedAt: preset.naloxoneCompleted ? naloxoneAt : null,
      }),
    );
    statements.push(sampleDiscordExemption(person));
    statements.push(`INSERT INTO volunteer_status (user_id, active, registration_approved, patrol_approved, approved_by, approved_at, application_rejection_reason, updated_at)
      SELECT ${id}, ${Number(preset.active)}, ${Number(preset.applicationApproved)}, ${Number(preset.patrolApproved)},
      ${preset.patrolApproved ? organizer : "NULL"}, ${preset.patrolApproved ? approvedAt : "NULL"}, ${preset.rejected ? quote("Sample application declined after review.") : "NULL"}, ${now}
      WHERE ${identity} AND EXISTS (SELECT 1 FROM profile WHERE user_id=${id})
      AND NOT EXISTS (SELECT 1 FROM volunteer_status WHERE user_id=${id})`);
    if (preset.applicationApproved)
      statements.push(`INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
        SELECT ${quote(`local-account-v2-approval-${preset.key}`)}, ${organizer}, ${id}, 'approval_changed',
        ${quote(JSON.stringify(preset.patrolApproved ? ["applicationApproved", "patrolApproved"] : ["applicationApproved"]))}, ${approvedAt}
        WHERE changes()=1 AND ${identity} ON CONFLICT(id) DO NOTHING`);
  }

  const date = (days: number, time: string) =>
    Date.parse(
      vancouverInstant(
        `${vancouverInput(now + days * 86_400_000).slice(0, 10)}T${time}`,
      ),
    );
  // Every event uses the current patrol + includesOrientation model. A private
  // historical fixture supplies real attendance records for experienced presets.
  for (const [key, days, time, orientation] of [
    ["orientation", 3, "18:00", true],
    ["patrol", 5, "20:30", false],
    ["past-orientation", 1, "18:00", true],
  ] as const) {
    statements.push(`INSERT INTO event (id, type, includes_orientation, starts_at, meeting_point, spots, open, hidden, created_by, created_at, updated_at)
      SELECT ${quote(eventId(key))}, 'patrol', ${Number(orientation)}, ${date(days, time)},
      ${quote(orientation ? "Strathcona Community Centre" : "Lord Strathcona Elementary School")}, 12, 1, 0, ${organizer}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM event WHERE id=${quote(eventId(key))})
      AND EXISTS (SELECT 1 FROM user WHERE id=${organizer} AND email='organizer.v2.local@example.org' AND role='organizer')`);
  }
  const past = quote(eventId("past-orientation"));
  // Historical attendance is inserted only with its newly-created hidden event;
  // reseeding never restores a developer-deleted signup or completion.
  for (const preset of manualAccountPresets.filter(
    ({ orientation }) => orientation !== "none",
  )) {
    const id = quote(preset.id);
    const email = quote(manualProfileFixture(preset, now).email);
    const signup = quote(`local-account-v2-signup-${preset.key}`);
    const completed = preset.orientation === "completed";
    const target = completed ? past : quote(eventId("orientation"));
    statements.push(`INSERT INTO signup (id, user_id, event_id, created_at, updated_at)
        SELECT ${signup}, ${id}, ${target}, ${completed ? date(-8, "18:00") : now}, ${completed ? date(-8, "18:00") : now}
        FROM event e JOIN volunteer_status v ON v.user_id=${id} JOIN profile p ON p.user_id=v.user_id
        WHERE e.id=${target} AND e.open=1 AND e.hidden=0 AND e.cancelled_at IS NULL
        AND coalesce(e.includes_orientation, e.type='orientation') AND e.starts_at>${now}
        AND ${
          completed
            ? `e.created_at=${now} AND e.updated_at=${now}`
            : `EXISTS (SELECT 1 FROM user WHERE id=${id} AND created_at=${now - 15 * 86_400_000} AND updated_at=${now})`
        }
        AND v.active=1 AND v.registration_approved=1
        AND p.naloxone_completed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM user WHERE id=${id} AND email=${email})
        AND (v.patrol_approved=1 OR (SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed'
          AND ${newVolunteerSql("s.user_id")})<4)
        AND (SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed')+1
          + max(0,2-(SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed' AND ${approvedMedicSql("s.user_id")})-CASE WHEN ${approvedMedicSql(id)} THEN 1 ELSE 0 END)
          + max(0,2-(SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed'
            AND ${newVolunteerSql("s.user_id")})-CASE WHEN ${newVolunteerSql(id)} THEN 1 ELSE 0 END)<=e.spots
        AND (v.patrol_approved=1 OR NOT EXISTS (SELECT 1 FROM signup s JOIN event booked ON booked.id=s.event_id
          WHERE s.user_id=${id} AND s.status='confirmed' AND booked.cancelled_at IS NULL
          AND booked.starts_at>${now} AND coalesce(booked.includes_orientation, booked.type='orientation')))
        AND NOT EXISTS (SELECT 1 FROM signup WHERE id=${signup})
        AND NOT EXISTS (SELECT 1 FROM signup WHERE user_id=${id} AND event_id=${target} AND status='confirmed')`);
  }
  statements.push(`UPDATE event SET starts_at=${date(-7, "18:00")}, open=0, hidden=1
    WHERE id=${past} AND created_at=${now} AND updated_at=${now}`);
  for (const preset of manualAccountPresets.filter(
    ({ orientation }) => orientation === "completed",
  )) {
    statements.push(`INSERT INTO orientation_completion (id, user_id, event_id, marked_by, marked_at)
      SELECT ${quote(`local-account-v2-completion-${preset.key}`)}, ${quote(preset.id)}, ${past}, ${organizer}, ${date(-7, "18:00")}
      WHERE EXISTS (SELECT 1 FROM event WHERE id=${past} AND created_at=${now} AND updated_at=${now})
      AND EXISTS (SELECT 1 FROM signup WHERE id=${quote(`local-account-v2-signup-${preset.key}`)} AND status='confirmed')
      AND EXISTS (SELECT 1 FROM user WHERE id=${quote(preset.id)} AND email=${quote(manualProfileFixture(preset, now).email)})
      ON CONFLICT(user_id, event_id) DO NOTHING`);
  }
  return statements;
}
