import { type Actor, requireOrganizer } from "../db/access";
import {
  isApplicationComplete,
  loadApplicationProgress,
} from "../db/application-progress";
import { listEvents } from "../db/events";
import { availableSignupSpots } from "../db/policy";
import { RequestError } from "../http";
import { personDisplayName } from "../../data/person-name";

/** Volunteer types an organizer can preview the event list as. */
export const viewAsTypes = {
  new: { label: "New volunteer", patrolApproved: false, medic: false },
  "new-medic": { label: "New medic", patrolApproved: false, medic: true },
  outreach: { label: "Outreach Volunteer", patrolApproved: true, medic: false },
  medic: { label: "Medic", patrolApproved: true, medic: true },
} as const;
export type ViewAsType = keyof typeof viewAsTypes;

export interface EventViewer {
  /** The query value that selects this viewer. */
  value: string;
  label: string;
  /** Read-only stand-in for the viewer; never used for writes. */
  actor: Actor;
  /** Medic eligibility for a type, which has no account to derive it from. */
  medicEligible?: boolean;
}

/**
 * Resolve an organizer's `viewAs` choice: a volunteer type, or `person:<id>`
 * for a specific volunteer. The result only shapes what is displayed.
 */
export async function resolveEventViewer(
  db: Env["DB"],
  organizer: Actor | null,
  value: string | null,
): Promise<EventViewer | null> {
  if (!value) return null;
  requireOrganizer(organizer);
  const base = {
    sessionId: "",
    twoFactorEnabled: false,
    twoFactorVerified: false,
    applicationSubmitted: true,
    applicationComplete: true,
    naloxoneCompleted: true,
    active: true,
    applicationApproved: true,
  };
  if (Object.hasOwn(viewAsTypes, value)) {
    const type = viewAsTypes[value as ViewAsType];
    return {
      value,
      label: type.label,
      medicEligible: type.medic && type.patrolApproved,
      actor: {
        ...base,
        // No account has this ID, so the viewer has no registrations.
        id: `view-as:${value}`,
        name: type.label,
        role: "volunteer",
        patrolApproved: type.patrolApproved,
      },
    };
  }
  const id = value.startsWith("person:") ? value.slice("person:".length) : "";
  const person = id
    ? await db
        .prepare(
          `SELECT u.id, u.name, u.role, p.first_name AS firstName, p.last_name AS lastName,
            p.preferred_name AS preferredName, p.naloxone_completed_at AS naloxoneCompletedAt,
            v.active, v.registration_approved AS applicationApproved,
            v.patrol_approved AS patrolApproved
          FROM user u JOIN profile p ON p.user_id = u.id
          JOIN volunteer_status v ON v.user_id = u.id
          WHERE u.id = ? AND u.deleted_at IS NULL`,
        )
        .bind(id)
        .first<{
          id: string;
          name: string;
          role: "volunteer" | "organizer";
          firstName: string | null;
          lastName: string | null;
          preferredName: string | null;
          naloxoneCompletedAt: number | null;
          active: number;
          applicationApproved: number;
          patrolApproved: number;
        }>()
    : null;
  if (!person) throw new RequestError(404, "Volunteer not found.");
  const name = personDisplayName(person, person.name);
  return {
    value,
    label: name,
    actor: {
      ...base,
      id: person.id,
      name,
      role: person.role,
      applicationComplete: isApplicationComplete(
        await loadApplicationProgress(db, person.id),
      ),
      naloxoneCompleted: person.naloxoneCompletedAt !== null,
      active: Boolean(person.active),
      applicationApproved: Boolean(person.applicationApproved),
      patrolApproved: Boolean(person.patrolApproved),
    },
  };
}

/** The volunteer event list exactly as the viewer would see it. */
export async function listViewerEvents(
  db: Env["DB"],
  viewer: EventViewer,
  view: "volunteer" | "past",
) {
  const events = await listEvents(db, viewer.actor, undefined, view);
  if (viewer.medicEligible === undefined) return events;
  return events.map((event) => {
    const row = { ...event, medicEligible: Number(viewer.medicEligible) };
    return {
      ...row,
      availableSpots: availableSignupSpots(row, row.confirmed, viewer.actor),
    };
  });
}
