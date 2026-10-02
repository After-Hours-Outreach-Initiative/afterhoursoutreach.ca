import { vancouverInput, vancouverInstant } from "../src/data/event-time";

export const fixtureUserId = (key: string) => `local-fixture-user-${key}`;
export const fixtureEventId = (key: string) => `local-fixture-event-${key}`;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Explicit local D1 seed data, never imported by the site or migrations. */
export function localEventFixtures(now = Date.now()) {
  const statements: string[] = [];
  const robin = quote(fixtureUserId("robin"));
  const date = (days: number, time = "20:30") =>
    Date.parse(
      vancouverInstant(
        `${vancouverInput(now + days * 86_400_000).slice(0, 10)}T${time}`,
      ),
    );
  const people = [
    { key: "robin", name: "Robin Vance", role: "organizer", approved: true },
    { key: "casey", name: "Casey Lee" },
    { key: "dana", name: "Dana Whitfield", approved: true },
    { key: "alex", name: "Alex Chen" },
    { key: "jamie", name: "Jamie Park", approved: true, inactive: true },
    { key: "sam", name: "Sam Rivera", role: "organizer", approved: true },
    { key: "first-sign-in", name: "", unregistered: true },
  ];
  for (const person of people) {
    const id = quote(fixtureUserId(person.key));
    statements.push(`INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (${id}, ${quote(person.name)}, ${quote(`${person.key}.local@example.org`)}, 1, ${quote(person.role ?? "volunteer")}, ${now}, ${now})
      ON CONFLICT(id) DO NOTHING`);
    if (person.unregistered) continue;
    statements.push(`INSERT INTO profile (
      user_id, preferred_name, pronouns, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, training_experience, registered_at, updated_at
    ) VALUES (${id}, ${quote(person.name)}, 'they/them', '604-555-0100', '1995-04-12',
      'Sample contact', '604-555-0101', 'Friend', 'A friend',
      'I would like to help our neighbours and support evening outreach.',
      '["outreach"]', 'Standard first aid', 'Community volunteering', ${now}, ${now})
      ON CONFLICT(user_id) DO NOTHING`);
    statements.push(`INSERT INTO volunteer_status (user_id, active, patrol_approved, approved_by, approved_at, updated_at)
      SELECT ${id}, ${person.inactive ? 0 : 1}, ${person.approved ? 1 : 0},
      ${person.approved ? robin : "NULL"}, ${person.approved ? now : "NULL"}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM volunteer_status WHERE user_id = ${id})`);
  }
  const school = "Lord Strathcona Elementary School";
  const map = "https://maps.app.goo.gl/y4huzDbXZ7eDmgiv5";
  const events = [
    {
      key: "orientation",
      type: "orientation",
      startsAt: date(3, "18:00"),
      point: "Strathcona Community Centre",
      spots: 12,
    },
    {
      key: "patrol",
      type: "patrol",
      startsAt: date(5),
      point: school,
      spots: 8,
      map,
    },
    {
      key: "full-patrol",
      type: "patrol",
      startsAt: date(12),
      point: school,
      spots: 1,
      map,
    },
    {
      key: "hidden-orientation",
      type: "orientation",
      startsAt: date(15),
      point: "Location to be confirmed",
      spots: 10,
      hidden: true,
    },
    // Insert in the future for the real signup eligibility trigger, then move
    // only this newly inserted fixture to the past after recording its roster.
    {
      key: "past-orientation",
      type: "orientation",
      startsAt: date(1, "18:00"),
      point: "Sample past orientation",
      spots: 12,
    },
  ];
  for (const event of events) {
    statements.push(`INSERT INTO event (id, type, starts_at, meeting_point, meeting_point_url,
      spots, open, hidden, created_by, created_at, updated_at)
      VALUES (${quote(fixtureEventId(event.key))}, ${quote(event.type)}, ${event.startsAt},
      ${quote(event.point)}, ${event.map ? quote(event.map) : "NULL"}, ${event.spots},
      ${event.hidden ? 0 : 1}, ${event.hidden ? 1 : 0}, ${robin}, ${now}, ${now})
      ON CONFLICT(id) DO NOTHING`);
  }
  for (const [person, event] of [
    ["casey", "orientation"],
    ["dana", "full-patrol"],
    ["alex", "past-orientation"],
  ]) {
    const id = quote(`local-fixture-signup-${person}`);
    const user = quote(fixtureUserId(person));
    const eventId = quote(fixtureEventId(event));
    // Do not rejoin cancelled signups or overwrite developer-edited fixtures.
    statements.push(`INSERT INTO signup (id, user_id, event_id, created_at, updated_at)
      SELECT ${id}, ${user}, ${eventId}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM signup WHERE id = ${id})
      AND NOT EXISTS (SELECT 1 FROM signup WHERE user_id = ${user} AND event_id = ${eventId} AND status = 'confirmed')
      AND EXISTS (SELECT 1 FROM event e JOIN volunteer_status v ON v.user_id = ${user}
        JOIN profile p ON p.user_id = v.user_id
        WHERE e.id = ${eventId} AND e.open = 1 AND e.hidden = 0 AND e.cancelled_at IS NULL
        AND e.starts_at > (julianday('now') - 2440587.5) * 86400000 AND v.active = 1
        AND (e.type = 'orientation' OR v.patrol_approved = 1)
        AND (SELECT count(*) FROM signup WHERE event_id = e.id AND status = 'confirmed') < e.spots)`);
  }
  const past = quote(fixtureEventId("past-orientation"));
  statements.push(`UPDATE event SET starts_at = ${date(-7, "18:00")}
    WHERE id = ${past} AND created_at = ${now} AND updated_at = ${now}`);
  statements.push(`INSERT INTO orientation_completion (id, user_id, event_id, marked_by, marked_at)
    SELECT 'local-fixture-completion-alex', ${quote(fixtureUserId("alex"))}, ${past}, ${robin}, ${date(-7, "18:00")}
    WHERE EXISTS (SELECT 1 FROM signup WHERE id = 'local-fixture-signup-alex' AND status = 'confirmed')
    ON CONFLICT(user_id, event_id) DO NOTHING`);
  return statements;
}
