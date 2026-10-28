import { vancouverInput, vancouverInstant } from "../src/data/event-time";
import {
  sampleProfileFixtures,
  sampleProfileStatement,
  sampleDiscordExemption,
} from "./sample-profile-fixtures";

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
  const people = sampleProfileFixtures("local", now);
  for (const person of people) {
    const id = quote(person.id);
    const organizer = ["robin", "sam"].includes(person.key);
    const approved = ["robin", "dana", "jamie", "sam"].includes(person.key);
    statements.push(`INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (${id}, ${quote(person.name)}, ${quote(person.email)}, 1, ${quote(organizer ? "organizer" : "volunteer")}, ${now}, ${now})
      ON CONFLICT(id) DO NOTHING`);
    statements.push(sampleProfileStatement(person, now));
    statements.push(sampleDiscordExemption(person));
    statements.push(`INSERT INTO volunteer_status (user_id, active, registration_approved, patrol_approved, approved_by, approved_at, updated_at)
      SELECT ${id}, ${person.key === "jamie" ? 0 : 1}, 1, ${approved ? 1 : 0},
      ${approved ? robin : "NULL"}, ${approved ? now : "NULL"}, ${now}
      WHERE EXISTS (SELECT 1 FROM user WHERE id = ${id} AND email = ${quote(person.email)})
      AND NOT EXISTS (SELECT 1 FROM volunteer_status WHERE user_id = ${id})`);
  }
  // Deliberately unsubmitted, so View as can exercise the first-sign-in flow.
  statements.push(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${quote(fixtureUserId("first-sign-in"))}, '', 'first-sign-in.local@example.org', 1, ${now}, ${now})
    ON CONFLICT(id) DO NOTHING`);
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
      // One booked general place plus two outstanding medic reservations.
      spots: 3,
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
      SELECT ${quote(fixtureEventId(event.key))}, ${quote(event.type)}, ${event.startsAt},
      ${quote(event.point)}, ${event.map ? quote(event.map) : "NULL"}, ${event.spots},
      ${event.hidden ? 0 : 1}, ${event.hidden ? 1 : 0}, ${robin}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM event WHERE id = ${quote(fixtureEventId(event.key))})
      AND EXISTS (SELECT 1 FROM user WHERE id = ${robin} AND email = 'robin.local@example.org')`);
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
      AND EXISTS (SELECT 1 FROM user WHERE id = ${user} AND email = ${quote(`${person}.local@example.org`)})
      AND NOT EXISTS (SELECT 1 FROM signup WHERE user_id = ${user} AND event_id = ${eventId} AND status = 'confirmed')
      AND EXISTS (SELECT 1 FROM event e JOIN volunteer_status v ON v.user_id = ${user}
        JOIN profile p ON p.user_id = v.user_id
        WHERE e.id = ${eventId} AND e.open = 1 AND e.hidden = 0 AND e.cancelled_at IS NULL
        AND e.starts_at > (julianday('now') - 2440587.5) * 86400000 AND v.active = 1 AND v.registration_approved = 1
        AND (e.type = 'orientation' OR v.patrol_approved = 1)
        AND (SELECT count(*) FROM signup WHERE event_id = e.id AND status = 'confirmed') < e.spots)`);
  }
  const past = quote(fixtureEventId("past-orientation"));
  statements.push(`UPDATE event SET starts_at = ${date(-7, "18:00")}
    WHERE id = ${past} AND created_at = ${now} AND updated_at = ${now}`);
  statements.push(`INSERT INTO orientation_completion (id, user_id, event_id, marked_by, marked_at)
    SELECT 'local-fixture-completion-alex', ${quote(fixtureUserId("alex"))}, ${past}, ${robin}, ${date(-7, "18:00")}
    WHERE EXISTS (SELECT 1 FROM signup WHERE id = 'local-fixture-signup-alex' AND status = 'confirmed')
    AND EXISTS (SELECT 1 FROM user WHERE id = ${quote(fixtureUserId("alex"))} AND email = 'alex.local@example.org')
    AND EXISTS (SELECT 1 FROM user WHERE id = ${robin} AND email = 'robin.local@example.org')
    ON CONFLICT(user_id, event_id) DO NOTHING`);
  return statements;
}
