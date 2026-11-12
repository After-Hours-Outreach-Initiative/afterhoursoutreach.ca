import { z } from "zod";
import { requireOrganizer, type Actor } from "@/server/db/access";
import { RequestError } from "@/server/http";
import {
  saveEvent,
  bulkSaveEvents,
  bulkEventSchema,
  cancelEvent,
  deleteEvent,
  deletePatrolSeries,
  changeSignup,
  addManualSignup,
  addEventVolunteers,
  addVolunteersSchema,
  manualSignupSchema,
  manageSignup,
  eventRequestSchema,
  patrolSeriesRequestSchema,
  patrolTemplateRequestSchema,
  savePatrolSeries,
  updatePatrolSeriesFrom,
  stopPatrolSeries,
  restorePatrolOccurrence,
} from "@/server/db/events";

const id = z.string().min(1).max(200);
const reason = z.string().trim().max(1000).default("");
const seriesScope = z.enum(["future", "all"]).default("future");
export const eventActionSchema = z.discriminatedUnion("action", [
  bulkEventSchema.extend({
    action: z.literal("bulk-save"),
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.enum(["delete-event", "delete-series"]),
    id,
    version: z.number().int().nonnegative(),
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("save-series"),
    id: id.optional(),
    version: z.number().int().nonnegative().optional(),
    series: patrolSeriesRequestSchema,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("update-series-from"),
    id,
    occurrenceDate: z.iso.date(),
    scope: seriesScope,
    version: z.number().int().nonnegative(),
    template: patrolTemplateRequestSchema,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("stop-series"),
    id,
    occurrenceDate: z.iso.date(),
    scope: seriesScope,
    version: z.number().int().nonnegative(),
    reason,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("restore-occurrence"),
    id,
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("save"),
    id: id.optional(),
    version: z.number().int().nonnegative().optional(),
    event: eventRequestSchema,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("cancel-event"),
    id,
    version: z.number().int().nonnegative(),
    reason,
    notify: z.boolean().default(false),
  }),
  z.strictObject({ action: z.enum(["join", "cancel"]), id }),
  manualSignupSchema.extend({ action: z.literal("add-attendee"), id }),
  z.strictObject({
    action: z.literal("add-volunteers"),
    id,
    volunteers: addVolunteersSchema,
  }),
  z.strictObject({
    action: z.literal("manage-signup"),
    id,
    destination: id.optional(),
    reason,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("retry-notifications"),
    operation: z.uuid(),
  }),
]);
export type EventActionInput = z.infer<typeof eventActionSchema>;

/** Run one validated events API action. The caller sends any email. */
export async function runEventAction(
  db: Env["DB"],
  actor: Actor,
  input: EventActionInput,
) {
  let result: { operation?: string; message: string; id?: string };
  switch (input.action) {
    case "bulk-save":
      result = await bulkSaveEvents(
        db,
        actor,
        {
          selection: input.selection,
          changes: input.changes,
        },
        input.notify,
      );
      break;
    case "delete-event":
      // Legacy clients receive exactly the same history-safe cancellation.
      result = await deleteEvent(
        db,
        actor,
        input.id,
        input.version,
        input.notify,
      );
      break;
    case "delete-series":
      result = await deletePatrolSeries(
        db,
        actor,
        input.id,
        input.version,
        input.notify,
      );
      break;
    case "save-series":
      result = await savePatrolSeries(
        db,
        actor,
        input.series,
        input.id,
        input.version,
        input.notify,
      );
      break;
    case "update-series-from":
      result = await updatePatrolSeriesFrom(
        db,
        actor,
        input.id,
        input.occurrenceDate,
        input.template,
        input.version,
        input.notify,
        input.scope,
      );
      break;
    case "stop-series":
      result = await stopPatrolSeries(
        db,
        actor,
        input.id,
        input.occurrenceDate,
        input.version,
        input.reason,
        input.notify,
        input.scope,
      );
      break;
    case "restore-occurrence":
      result = await restorePatrolOccurrence(db, actor, input.id, input.version);
      break;
    case "save":
      result = await saveEvent(
        db,
        actor,
        input.event,
        input.id,
        input.version,
        input.notify,
      );
      break;
    case "cancel-event":
      result = await cancelEvent(
        db,
        actor,
        input.id,
        input.version,
        input.reason,
        input.notify,
      );
      break;
    case "join":
    case "cancel":
      result = await changeSignup(db, actor, input.id, input.action);
      break;
    case "manage-signup":
      result = await manageSignup(
        db,
        actor,
        input.id,
        input.destination,
        input.reason,
        input.notify,
      );
      break;
    case "add-attendee":
      result = await addManualSignup(db, actor, input.id, {
        name: input.name,
        medic: input.medic,
        newVolunteer: input.newVolunteer,
      });
      break;
    case "add-volunteers":
      result = await addEventVolunteers(db, actor, input.id, input.volunteers);
      break;
    case "retry-notifications":
      requireOrganizer(actor);
      if (
        !(await db
          .prepare(
            "SELECT id FROM event_audit WHERE id=? UNION ALL SELECT id FROM patrol_series_audit WHERE id=? LIMIT 1",
          )
          .bind(input.operation, input.operation)
          .first())
      )
        throw new RequestError(404, "Email action not found.");
      result = {
        operation: input.operation,
        message:
          "Email retry complete. The event/registration change was not repeated.",
      };
      break;
  }
  return result;
}

/** Never send (or create retryable mail) without explicit organizer consent. */
export const eventActionNotifies = (input: EventActionInput) =>
  input.action === "retry-notifications" || ("notify" in input && input.notify);
