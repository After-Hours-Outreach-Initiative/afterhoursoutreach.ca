import { orientationNeededMessage } from "../../data/event-limits";
import { RequestError } from "../http";
import { signupNewVolunteerSql } from "./sql";

/** Refuse dropping the orientation from events with new volunteers booked.
 * Checked before any write, so a change that would wait for undo is refused
 * when it is made rather than when its timer ends. Triggers still guard the
 * write itself. */
export async function assertOrientationKept(db: Env["DB"], eventIds: string[]) {
  if (!eventIds.length) return;
  const booked = await db
    .prepare(
      `SELECT count(*) AS n FROM signup s
      WHERE s.event_id IN (SELECT value FROM json_each(?))
        AND s.status = 'confirmed' AND ${signupNewVolunteerSql()}`,
    )
    .bind(JSON.stringify(eventIds))
    .first<number>("n");
  if (booked) throw new RequestError(409, orientationNeededMessage);
}
