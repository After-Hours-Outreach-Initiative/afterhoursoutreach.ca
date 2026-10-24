import { vancouverInput, vancouverInstant } from "../src/data/event-time";
import { applicationDraftAnswersSchema } from "../src/data/application-draft";
import { localAccountUserId, manualAccountPresets } from "../src/dev/accounts";
import { approvedMedicSql } from "../src/server/db/sql";
import {
  sampleProfileFixtures,
  sampleProfileStatement,
} from "./sample-profile-fixtures";

export { localAccountUserId } from "../src/dev/accounts";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const eventId = (key: string) => `local-account-event-${key}`;

/** Manual View as personas, separate from the broader automated-test fixtures. */
export function localAccountFixtures(now = Date.now()) {
  const statements: string[] = [];
  const people = sampleProfileFixtures("local", now);
  const organizer = quote(localAccountUserId("organizer"));
  const submittedAt = now - 14 * 86_400_000;
  const naloxoneAt = now - 13 * 86_400_000;
  const approvedAt = now - 12 * 86_400_000;
  // Create every identity first: patrol approvals must reference a real organizer.
  for (const preset of manualAccountPresets) {
    const person = people.find(({ key }) => key === preset.sampleKey)!;
    statements.push(`INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (${quote(preset.id)}, ${quote(person.name)}, ${quote(`${preset.key}.local@example.org`)}, 1, ${quote(preset.role)}, ${now - 15 * 86_400_000}, ${now})
      ON CONFLICT(id) DO NOTHING`);
    if (preset.draft) {
      const answers = applicationDraftAnswersSchema.parse({
        firstName: person.answers.firstName,
        lastName: person.answers.lastName,
        phone: person.answers.phone,
        teams: ["outreach"],
      });
      statements.push(`INSERT INTO application_draft (user_id, version, revision, answers, updated_at)
        SELECT ${quote(preset.id)}, 1, 'e261e220-743b-4d91-b5cd-5966407e1396', ${quote(JSON.stringify(answers))}, ${now}
        WHERE changes()=1 AND EXISTS (SELECT 1 FROM user WHERE id=${quote(preset.id)} AND email=${quote(`${preset.key}.local@example.org`)})
        AND NOT EXISTS (SELECT 1 FROM profile WHERE user_id=${quote(preset.id)})
        AND NOT EXISTS (SELECT 1 FROM application_draft_generation WHERE user_id=${quote(preset.id)})
        ON CONFLICT(user_id) DO NOTHING`);
    }
  }
  for (const preset of manualAccountPresets) {
    const id = quote(preset.id);
    const email = `${preset.key}.local@example.org`;
    const person = {
      ...people.find(({ key }) => key === preset.sampleKey)!,
      id: preset.id,
      email,
    };
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
      const repair = quote(`local-account-upgrade-${preset.key}`);
      const a = person.answers;
      const original = {
        first_name: a.firstName,
        middle_names: a.middleNames,
        last_name: a.lastName,
        preferred_name: a.preferredName,
        pronouns: a.pronouns,
        phone: a.phone,
        birth_date: a.birthDate,
        emergency_contact_name: a.emergencyName,
        emergency_contact_phone: a.emergencyPhone,
        emergency_contact_relationship: a.emergencyRelationship,
        heard_about_us: a.heardAboutUs,
        heard_about_us_sources: JSON.stringify(a.heardAboutUsSources),
        heard_about_us_other: a.heardAboutUsOther,
        motivation: a.motivation,
        teams: JSON.stringify(a.teams),
        medical_certification: a.certification,
        medical_certifications: JSON.stringify(a.certifications),
        medical_certification_expiry: a.certificationExpiry,
        training_experience: a.experience,
        relevant_training: JSON.stringify(a.training),
        other_training: a.otherTraining,
        relevant_experience: JSON.stringify(a.relevantExperience),
        other_experience: a.otherExperience,
        medical_conditions: a.medicalConditions,
      };
      statements.push(`INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
        SELECT ${repair}, ${organizer}, ${id}, 'profile_updated', '["naloxoneCompletedAt"]', ${now}
        FROM user u JOIN profile p ON p.user_id=u.id JOIN volunteer_status v ON v.user_id=u.id
        WHERE u.id=${id} AND u.email=${quote(email)} AND u.name=${quote(String(legacy[0]))}
        AND u.role=${quote(preset.role)} AND p.updated_at=p.registered_at AND v.updated_at=p.registered_at
        AND p.naloxone_completed_at IS NULL AND v.active=${legacy[1]} AND v.registration_approved=${legacy[2]}
        AND v.patrol_approved=0 AND json_valid(p.submitted_application)
        AND ${Object.entries(original)
          .map(([column, value]) => `coalesce(p.${column}, '')=${quote(value)}`)
          .join(" AND ")}
        AND p.code_of_conduct_version=json_extract(p.submitted_application, '$.codeOfConductVersion')
        AND p.code_of_conduct_accepted_at=p.registered_at
        AND json_extract(p.submitted_application, '$.email')=u.email
        AND json_extract(p.submitted_application, '$.answers')=${quote(JSON.stringify(person.answers))}
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE subject_id=${id})
        AND NOT EXISTS (SELECT 1 FROM signup WHERE user_id=${id})
        AND NOT EXISTS (SELECT 1 FROM orientation_completion WHERE user_id=${id})
        AND EXISTS (SELECT 1 FROM user WHERE id=${organizer} AND email='organizer.local@example.org' AND role='organizer')
        ON CONFLICT(id) DO NOTHING`);
      statements.push(`UPDATE profile SET naloxone_completed_at=${now}
        WHERE user_id=${id} AND changes()=1 AND EXISTS (SELECT 1 FROM audit_log WHERE id=${repair})`);
      statements.push(`UPDATE volunteer_status SET registration_approved=1, updated_at=max(${now}, updated_at+1)
        WHERE user_id=${id} AND changes()=1 AND EXISTS (SELECT 1 FROM audit_log WHERE id=${repair})`);
      statements.push(`INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
        SELECT ${quote(`local-account-upgrade-approval-${preset.key}`)}, ${organizer}, ${id}, 'approval_changed', '["applicationApproved"]', ${now}
        WHERE changes()=1 AND EXISTS (SELECT 1 FROM audit_log WHERE id=${repair})`);
    }

    statements.push(
      sampleProfileStatement(person, submittedAt, {
        naloxoneCompletedAt: preset.naloxoneCompleted ? naloxoneAt : null,
      }),
    );
    statements.push(`INSERT INTO volunteer_status (user_id, active, registration_approved, patrol_approved, approved_by, approved_at, updated_at)
      SELECT ${id}, ${Number(preset.active)}, ${Number(preset.applicationApproved)}, ${Number(preset.patrolApproved)},
      ${preset.patrolApproved ? organizer : "NULL"}, ${preset.patrolApproved ? approvedAt : "NULL"}, ${now}
      WHERE ${identity} AND EXISTS (SELECT 1 FROM profile WHERE user_id=${id})
      AND NOT EXISTS (SELECT 1 FROM volunteer_status WHERE user_id=${id})`);
    if (preset.applicationApproved)
      statements.push(`INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
        SELECT ${quote(`local-account-approval-${preset.key}`)}, ${organizer}, ${id}, 'approval_changed',
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
      AND EXISTS (SELECT 1 FROM user WHERE id=${organizer} AND email='organizer.local@example.org' AND role='organizer')`);
  }
  const past = quote(eventId("past-orientation"));
  // Historical attendance is inserted only with its newly-created hidden event;
  // reseeding never restores a developer-deleted signup or completion.
  for (const preset of manualAccountPresets.filter(
    ({ orientation }) => orientation !== "none",
  )) {
    const id = quote(preset.id);
    const email = quote(`${preset.key}.local@example.org`);
    const signup = quote(`local-account-signup-${preset.key}`);
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
        AND NOT EXISTS (SELECT 1 FROM orientation_completion WHERE user_id=${id})
        AND (SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed'
          AND NOT EXISTS (SELECT 1 FROM orientation_completion o WHERE o.user_id=s.user_id))<4
        AND (SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed')+1
          + max(0,2-(SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed' AND ${approvedMedicSql("s.user_id")}))
          + max(0,1-(SELECT count(*) FROM signup s WHERE s.event_id=e.id AND s.status='confirmed'
            AND NOT EXISTS (SELECT 1 FROM orientation_completion o WHERE o.user_id=s.user_id)))<=e.spots
        AND NOT EXISTS (SELECT 1 FROM signup s JOIN event booked ON booked.id=s.event_id
          WHERE s.user_id=${id} AND s.status='confirmed' AND booked.cancelled_at IS NULL
          AND booked.starts_at>${now} AND coalesce(booked.includes_orientation, booked.type='orientation'))
        AND NOT EXISTS (SELECT 1 FROM signup WHERE id=${signup})
        AND NOT EXISTS (SELECT 1 FROM signup WHERE user_id=${id} AND event_id=${target} AND status='confirmed')`);
  }
  statements.push(`UPDATE event SET starts_at=${date(-7, "18:00")}, open=0, hidden=1
    WHERE id=${past} AND created_at=${now} AND updated_at=${now}`);
  for (const preset of manualAccountPresets.filter(
    ({ orientation }) => orientation === "completed",
  )) {
    statements.push(`INSERT INTO orientation_completion (id, user_id, event_id, marked_by, marked_at)
      SELECT ${quote(`local-account-completion-${preset.key}`)}, ${quote(preset.id)}, ${past}, ${organizer}, ${date(-7, "18:00")}
      WHERE EXISTS (SELECT 1 FROM event WHERE id=${past} AND created_at=${now} AND updated_at=${now})
      AND EXISTS (SELECT 1 FROM signup WHERE id=${quote(`local-account-signup-${preset.key}`)} AND status='confirmed')
      AND EXISTS (SELECT 1 FROM user WHERE id=${quote(preset.id)} AND email=${quote(`${preset.key}.local@example.org`)})
      ON CONFLICT(user_id, event_id) DO NOTHING`);
  }
  return statements;
}
