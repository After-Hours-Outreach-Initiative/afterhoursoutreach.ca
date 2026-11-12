import { z } from "zod";
import type { AuthBindings } from "./auth";
import type { Actor } from "./db/access";
import {
  setVolunteerStatus,
  setRole,
  approveForPatrols,
  patrolApprovalSchema,
  statusSchema,
  rejectionSchema,
  rejectApplication,
} from "./db/volunteers";
import { submissionNotificationMode } from "./db/submission-notifications";
import { RequestError } from "./http";

const id = z.string().min(1).max(200);
export const organizerActionSchema = z.discriminatedUnion("action", [
  statusSchema.extend({ action: z.literal("status") }),
  rejectionSchema.extend({ action: z.literal("reject-application") }),
  patrolApprovalSchema.extend({ action: z.literal("approve-patrols") }),
  z.strictObject({
    action: z.literal("role"),
    userId: id,
    role: z.enum(["volunteer", "organizer"]),
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("retry-notifications"),
    operation: z.uuid(),
  }),
]);
export type OrganizerActionInput = z.infer<typeof organizerActionSchema>;

/** Run one validated organizer API action. The caller sends any email. */
export async function runOrganizerAction(
  bindings: AuthBindings,
  actor: Actor,
  input: OrganizerActionInput,
): Promise<{ operation?: string; message: string; staffNotified?: boolean }> {
  const db = bindings.DB;
  if (input.action === "retry-notifications") {
    if (
      !(await db
        .prepare(
          "SELECT id FROM audit_log WHERE id=? AND action IN ('approval_changed','active_changed','role_changed','application_rejected')",
        )
        .bind(input.operation)
        .first())
    )
      throw new RequestError(404, "Email action not found.");
    return {
      operation: input.operation,
      message: "Email retry complete. The account change was not repeated.",
    };
  }
  if (input.action === "status")
    return setVolunteerStatus(
      db,
      actor,
      {
        userId: input.userId,
        version: input.version,
        active: input.active,
        applicationApproved: input.applicationApproved,
        registrationApproved: input.registrationApproved,
        patrolApproved: input.patrolApproved,
        notify: input.notify,
        reason: input.reason,
      },
      // Branch previews never email the organization inbox.
      submissionNotificationMode(bindings) !== "preview",
    );
  if (input.action === "approve-patrols")
    return approveForPatrols(db, actor, {
      userId: input.userId,
      version: input.version,
      eventId: input.eventId,
      notify: input.notify,
    });
  if (input.action === "reject-application")
    return rejectApplication(db, actor, {
      userId: input.userId,
      version: input.version,
      reason: input.reason,
    });
  return setRole(db, actor, input.userId, input.role, input.notify);
}

export const organizerActionNotifies = (
  input: OrganizerActionInput,
  result: { staffNotified?: boolean },
) =>
  input.action === "retry-notifications" ||
  input.action === "reject-application" ||
  ("notify" in input && input.notify) ||
  result.staffNotified === true;
