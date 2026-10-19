import { vancouverInput, vancouverInstant } from "../src/data/event-time";
import {
  sampleProfileFixtures,
  sampleProfileStatement,
} from "./sample-profile-fixtures";

export const localAccountUserId = (key: string) => `local-account-user-${key}`;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Manual View as personas, separate from the broader automated-test fixtures. */
export function localAccountFixtures(now = Date.now()) {
  const statements: string[] = [];
  const people = sampleProfileFixtures("local", now);
  for (const [key, name, sampleKey] of [
    ["not-applied", "Not applied", null],
    ["applied", "Applied", "casey"],
    ["accepted", "Accepted", "alex"],
    ["inactive", "Inactive", "jamie"],
    ["organizer", "Organizer", "robin"],
  ] as const) {
    const id = localAccountUserId(key);
    const email = `${key}.local@example.org`;
    statements.push(`INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (${quote(id)}, ${quote(name)}, ${quote(email)}, 1, ${quote(key === "organizer" ? "organizer" : "volunteer")}, ${now}, ${now})
      ON CONFLICT(id) DO NOTHING`);
    // The first-sign-in persona has no profile, draft, or volunteer status.
    if (!sampleKey) continue;
    const person = people.find((person) => person.key === sampleKey)!;
    statements.push(
      sampleProfileStatement({ ...person, id, email, name }, now),
    );
    statements.push(`INSERT INTO volunteer_status (user_id, active, registration_approved, patrol_approved, updated_at)
      SELECT ${quote(id)}, ${key === "inactive" ? 0 : 1}, ${["accepted", "organizer"].includes(key) ? 1 : 0}, 0, ${now}
      WHERE EXISTS (SELECT 1 FROM user WHERE id = ${quote(id)} AND email = ${quote(email)})
      AND NOT EXISTS (SELECT 1 FROM volunteer_status WHERE user_id = ${quote(id)})`);
  }
  // A couple of open events make the accepted/organizer views useful, without
  // adding more personas, signups, attendance, or approval scenarios.
  const organizer = quote(localAccountUserId("organizer"));
  for (const [type, days, time, point] of [
    ["orientation", 3, "18:00", "Strathcona Community Centre"],
    ["patrol", 5, "20:30", "Lord Strathcona Elementary School"],
  ] as const) {
    const startsAt = Date.parse(
      vancouverInstant(
        `${vancouverInput(now + days * 86_400_000).slice(0, 10)}T${time}`,
      ),
    );
    const id = quote(`local-account-event-${type}`);
    statements.push(`INSERT INTO event (id, type, starts_at, meeting_point, spots, open, created_by, created_at, updated_at)
      SELECT ${id}, ${quote(type)}, ${startsAt}, ${quote(point)}, 12, 1, ${organizer}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM event WHERE id = ${id})
      AND EXISTS (SELECT 1 FROM user WHERE id = ${organizer} AND email = 'organizer.local@example.org')`);
  }
  return statements;
}
