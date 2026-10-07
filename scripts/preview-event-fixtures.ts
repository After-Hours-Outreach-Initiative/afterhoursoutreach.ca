import { vancouverInput, vancouverInstant } from "../src/data/event-time";
import { nowMsSql } from "../src/server/db/sql";

export const previewUserId = (key: string) => `preview-fixture-user-${key}`;
export const previewEventId = (key: string) => `preview-fixture-event-${key}`;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Synthetic preview data only; never imported by the site or migrations. */
export function previewEventFixtures(now = Date.now()) {
  const statements: string[] = [];
  const today = vancouverInput(now).slice(0, 10);
  const date = (days: number, time: string) => {
    // Add calendar days, not 24-hour durations that can shift the local date at DST.
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + days);
    return Date.parse(
      vancouverInstant(`${day.toISOString().slice(0, 10)}T${time}`),
    );
  };
  const people = [
    { key: "robin", name: "Robin Vance" },
    { key: "casey", name: "Casey Lee" },
    { key: "dana", name: "Dana Whitfield" },
    { key: "alex", name: "Alex Chen" },
    { key: "jamie", name: "Jamie Park", inactive: true },
    { key: "sam", name: "Sam Rivera" },
  ];
  for (const person of people) {
    const id = quote(previewUserId(person.key));
    const name = quote(`${person.name} (sample)`);
    // No passwords, verified emails, sessions, or organizer privileges.
    statements.push(`INSERT INTO user (id, name, email, created_at, updated_at)
      VALUES (${id}, ${name}, ${quote(`${person.key}@preview.example.invalid`)}, ${now}, ${now})
      ON CONFLICT(id) DO NOTHING`);
    statements.push(`INSERT INTO profile (
      user_id, preferred_name, pronouns, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, training_experience, registered_at, updated_at
    ) VALUES (${id}, ${name}, 'they/them', '604-555-0100', '1995-04-12',
      'Sample contact', '604-555-0101', 'Friend', 'Preview sample data',
      'Sample answer: help our neighbours through evening outreach.',
      '["outreach"]', 'Sample first aid certification', 'Sample volunteering experience', ${now}, ${now})
      ON CONFLICT(user_id) DO NOTHING`);
    statements.push(`INSERT INTO volunteer_status (user_id, active, updated_at)
      VALUES (${id}, ${person.inactive ? 0 : 1}, ${now})
      ON CONFLICT(user_id) DO NOTHING`);
  }
  const events = [
    {
      key: "orientation",
      type: "orientation",
      days: 3,
      time: "18:00",
      point: "Strathcona Community Centre",
      spots: 12,
    },
    {
      key: "patrol",
      type: "patrol",
      days: 5,
      time: "20:30",
      point: "Lord Strathcona Elementary School",
      spots: 8,
    },
    {
      key: "full-orientation",
      type: "orientation",
      days: 7,
      time: "18:00",
      point: "Strathcona Community Centre",
      spots: 2,
    },
    {
      key: "closed-patrol",
      type: "patrol",
      days: 10,
      time: "20:30",
      point: "Lord Strathcona Elementary School",
      spots: 8,
      closed: true,
    },
    {
      key: "hidden-orientation",
      type: "orientation",
      days: 14,
      time: "18:00",
      point: "Location to be confirmed",
      spots: 10,
      closed: true,
      hidden: true,
    },
  ];
  for (const event of events) {
    statements.push(`INSERT INTO event (id, type, starts_at, meeting_point,
      spots, open, hidden, created_by, created_at, updated_at)
      VALUES (${quote(previewEventId(event.key))}, ${quote(event.type)}, ${date(event.days, event.time)},
      ${quote(`[Sample] ${event.point}`)}, ${event.spots}, ${event.closed ? 0 : 1}, ${event.hidden ? 1 : 0},
      ${quote(previewUserId("robin"))}, ${now}, ${now})
      ON CONFLICT(id) DO NOTHING`);
  }
  for (const [person, event] of [
    ["casey", "orientation"],
    ["alex", "orientation"],
    ["dana", "full-orientation"],
    ["sam", "full-orientation"],
  ]) {
    const id = quote(`preview-fixture-signup-${person}`);
    const user = quote(previewUserId(person));
    const eventId = quote(previewEventId(event));
    // Respect eligibility/capacity, fixture edits, and cancelled/moved signups.
    statements.push(`INSERT INTO signup (id, user_id, event_id, created_at, updated_at)
      SELECT ${id}, ${user}, ${eventId}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM signup WHERE id = ${id})
      AND NOT EXISTS (SELECT 1 FROM signup WHERE user_id = ${user} AND event_id = ${eventId})
      AND EXISTS (SELECT 1 FROM event e JOIN volunteer_status v ON v.user_id = ${user}
        JOIN profile p ON p.user_id = v.user_id
        WHERE e.id = ${eventId} AND e.open = 1 AND e.hidden = 0 AND e.cancelled_at IS NULL
        AND e.starts_at > ${nowMsSql} AND v.active = 1
        AND (e.type = 'orientation' OR v.patrol_approved = 1)
        AND (SELECT count(*) FROM signup WHERE event_id = e.id AND status = 'confirmed') < e.spots)`);
  }
  return statements;
}
