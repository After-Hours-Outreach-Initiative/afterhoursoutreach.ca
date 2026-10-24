import { sampleProfileFixtures } from "../../../scripts/sample-profile-fixtures";
import {
  permissionValues,
  writePermission,
  type Actor,
} from "../../server/db/access";
import { loadApplicationProgress } from "../../server/db/application-progress";
import { confirmNaloxoneCompletion } from "../../server/db/naloxone";
import { saveProfile } from "../../server/db/profiles";
import { RequestError } from "../../server/http";
import type { DevelopmentApplicationStep } from "../accounts";

/** Local-only shortcuts: keep normal submission validation and immutable snapshots. */
export async function completeLocalApplicationStep(
  db: Env["DB"],
  actor: Actor,
  step: DevelopmentApplicationStep,
) {
  if (step === "form") {
    const sample = sampleProfileFixtures("local", Date.now()).find(
      (person) => person.key === "casey",
    )!;
    // No notification callback: sample submissions must never queue real emails.
    await saveProfile(
      db,
      actor.id,
      { ...sample.answers, codeOfConductAccepted: true },
      { actor, intent: "submit" },
    );
    return;
  }
  if (step === "naloxone") {
    await confirmNaloxoneCompletion(db, actor, {
      userId: actor.id,
      completed: true,
    });
    return;
  }

  const progress = await loadApplicationProgress(db, actor.id);
  if (progress.submittedAt === null || progress.naloxoneCompletedAt === null)
    throw new RequestError(
      409,
      "Submit the application and complete Naloxone 101 first.",
    );
  if (progress.applicationApproved) return;
  const now = Date.now();
  // This deliberate development-only approval bypass changes only this account's
  // application approval. It neither upgrades the role/patrol approval nor sends mail.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE volunteer_status
         SET registration_approved=1, updated_at=max(?, updated_at+1)
         WHERE user_id=? AND registration_approved=0
           AND EXISTS (SELECT 1 FROM profile WHERE user_id=? AND naloxone_completed_at IS NOT NULL)
           AND ${writePermission()}`,
      )
      .bind(now, actor.id, actor.id, ...permissionValues(actor)),
    db
      .prepare(
        `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
         SELECT ?, ?, ?, 'approval_changed', '["applicationApproved"]', ? WHERE changes()=1`,
      )
      .bind(crypto.randomUUID(), actor.id, actor.id, now),
  ]);
  if (
    !results[0].meta.changes &&
    !(await loadApplicationProgress(db, actor.id)).applicationApproved
  )
    throw new RequestError(
      409,
      "Your account changed. Reload before completing this step.",
    );
}
