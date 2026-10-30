import { applicationDraftAnswersSchema } from "../../data/application-draft";
import {
  developmentStateOrganizerId,
  developmentStateProvider,
  manualAccountPresets,
} from "../accounts";
import { RequestError } from "../../server/http";
import {
  sampleProfileFixtures,
  sampleProfileStatement,
} from "../../../scripts/sample-profile-fixtures";
import { manualProfileFixture } from "../../../scripts/manual-profile-fixtures";

/** Reuse one browser-owned sandbox, never a growing collection of saved accounts. */
export async function resetAccountState(
  db: Env["DB"],
  key: string,
  slot: string,
) {
  const preset = manualAccountPresets.find((preset) => preset.key === key);
  if ((!preset && key !== "not-applied") || !/^[0-9a-f-]{36}$/.test(slot))
    throw new RequestError(400, "Choose a known local account state.");
  const id = `local-state-${slot}`,
    organizer = developmentStateOrganizerId,
    now = Date.now();
  // Never overwrite an unrelated identity even if it occupies a reserved ID.
  for (const userId of [id, organizer]) {
    const collision = await db
      .prepare(
        `SELECT 1 FROM user u WHERE u.id=? AND NOT EXISTS
      (SELECT 1 FROM account a WHERE a.user_id=u.id AND a.provider_id=?)`,
      )
      .bind(userId, developmentStateProvider)
      .first();
    if (collision)
      throw new RequestError(
        409,
        "A reserved test identity belongs to a saved account. No state was reset.",
      );
  }
  if (
    await db
      .prepare(
        "SELECT 1 FROM discord_link WHERE user_id=? AND guild_id!='local-only'",
      )
      .bind(id)
      .first()
  )
    throw new RequestError(
      409,
      "Remove the real Discord connection before resetting this test account.",
    );

  const samples = sampleProfileFixtures("local", now);
  const sample = preset
    ? manualProfileFixture(preset, now)
    : samples.find((person) => person.key === "casey")!;
  const name = `${sample.name} (sandbox ${slot.slice(0, 8)})`;
  const person = {
    ...sample,
    id,
    name,
    email: `${id}@example.invalid`,
    answers: { ...sample.answers, preferredName: name },
  };
  const helperSample = samples.find((person) => person.key === "robin")!;
  const helper = {
    ...helperSample,
    id: organizer,
    name: "State setup organizer",
    email: `${organizer}@example.invalid`,
    answers: {
      ...helperSample.answers,
      preferredName: "State setup organizer",
    },
  };
  const submittedAt = now - 14 * 86_400_000,
    naloxoneAt = now - 13 * 86_400_000,
    approvedAt = now - 12 * 86_400_000;
  const statements = [
    // This fixed helper owns sample attendance/approvals and keeps resetting an
    // Organizer state from running into the last-active-organizer protection.
    ...identityStatements(
      db,
      organizer,
      now,
      "State setup organizer",
      "organizer",
    ),
    db.prepare(
      sampleProfileStatement(helper, submittedAt, {
        naloxoneCompletedAt: naloxoneAt,
      }),
    ),
    db
      .prepare(
        `INSERT INTO volunteer_status (user_id,active,registration_approved,updated_at)
      VALUES (?,1,1,?) ON CONFLICT(user_id) DO UPDATE SET active=1,registration_approved=1`,
      )
      .bind(organizer, now),
    ...identityStatements(
      db,
      id,
      now,
      preset ? person.name : "Test application",
      preset?.role ?? "volunteer",
    ),
    // Old tabs lose authorization, and a new generation prevents their browser
    // backups/delayed autosaves from restoring answers from a previous scenario.
    db.prepare("DELETE FROM session WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM two_factor WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM discord_oauth WHERE user_id=?").bind(id),
    db
      .prepare(
        "DELETE FROM discord_link WHERE user_id=? AND guild_id='local-only'",
      )
      .bind(id),
    db
      .prepare(
        "DELETE FROM application_submission_notification WHERE user_id=?",
      )
      .bind(id),
    db.prepare("DELETE FROM event_notification WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM signup WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM orientation_completion WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM audit_log WHERE subject_id=?").bind(id),
    db.prepare("DELETE FROM profile WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM volunteer_status WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM discord_requirement WHERE user_id=?").bind(id),
    db
      .prepare(
        `INSERT INTO application_draft_generation (user_id,generation) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation`,
      )
      .bind(id, crypto.randomUUID()),
  ];
  if (preset?.draft) {
    const answers = applicationDraftAnswersSchema.parse({
      firstName: sample.answers.firstName,
      lastName: sample.answers.lastName,
      phone: sample.answers.phone,
      teams: sample.answers.teams,
    });
    statements.push(
      db
        .prepare(
          `INSERT INTO application_draft (user_id,version,revision,answers,updated_at)
      VALUES (?,1,?,?,?)`,
        )
        .bind(id, crypto.randomUUID(), JSON.stringify(answers), now),
    );
  } else if (preset) {
    statements.push(
      db.prepare(
        sampleProfileStatement(person, submittedAt, {
          naloxoneCompletedAt: preset.naloxoneCompleted ? naloxoneAt : null,
        }),
      ),
    );
    if (preset.naloxoneCompleted)
      statements.push(simulatedDiscord(db, id, naloxoneAt));
    statements.push(
      db
        .prepare(
          `INSERT INTO volunteer_status
      (user_id,active,registration_approved,patrol_approved,approved_by,approved_at,application_rejection_reason,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          Number(preset.active),
          Number(preset.applicationApproved),
          Number(preset.patrolApproved),
          preset.patrolApproved ? organizer : null,
          preset.patrolApproved ? approvedAt : null,
          preset.rejected ? "Sample application declined after review." : null,
          now,
        ),
    );
    if (preset.applicationApproved)
      statements.push(
        db
          .prepare(
            `INSERT INTO audit_log
      (id,actor_id,subject_id,action,changed_fields,created_at) VALUES (?,?,?,'approval_changed',?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            organizer,
            id,
            JSON.stringify(
              preset.patrolApproved
                ? ["applicationApproved", "patrolApproved"]
                : ["applicationApproved"],
            ),
            approvedAt,
          ),
      );
    if (preset.orientation !== "none") {
      const eventId = `${id}-orientation-${preset.orientation}`;
      // Keep sample events bounded too. Never discard another volunteer's
      // booking or attendance to reset a state that has become a shared event.
      const shared = await db
        .prepare(
          `SELECT 1 WHERE EXISTS(SELECT 1 FROM signup WHERE event_id=? AND user_id!=?)
        OR EXISTS(SELECT 1 FROM orientation_completion WHERE event_id=? AND user_id!=?)`,
        )
        .bind(eventId, id, eventId, id)
        .first();
      if (shared)
        throw new RequestError(
          409,
          "This test orientation has other volunteers. Remove their sample bookings before resetting it.",
        );
      statements.push(
        db
          .prepare(
            `INSERT INTO event
        (id,type,includes_orientation,starts_at,meeting_point,spots,open,created_by,created_at,updated_at)
        VALUES (?,'patrol',1,?,'Sample state orientation',8,1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET starts_at=excluded.starts_at,spots=8,open=1,hidden=0,cancelled_at=NULL,updated_at=excluded.updated_at`,
          )
          .bind(eventId, now + 3 * 86_400_000, organizer, now, now),
        db
          .prepare(
            `INSERT INTO signup (id,user_id,event_id,created_at,updated_at) VALUES (?,?,?,?,?)`,
          )
          .bind(crypto.randomUUID(), id, eventId, now, now),
      );
      if (preset.orientation === "completed")
        statements.push(
          db
            .prepare(
              `INSERT INTO orientation_completion (id,user_id,event_id,marked_by,marked_at)
          VALUES (?,?,?,?,?)`,
            )
            .bind(
              crypto.randomUUID(),
              id,
              eventId,
              organizer,
              now - 7 * 86_400_000,
            ),
          db
            .prepare("UPDATE event SET starts_at=?,open=0,hidden=1 WHERE id=?")
            .bind(now - 7 * 86_400_000, eventId),
        );
    }
  }
  // Only this explicitly temporary identity is reset. Saved profiles, sessions,
  // snapshots, audits and credentials are never used as state templates or erased.
  await db.batch(statements);
  return id;
}

function identityStatements(
  db: Env["DB"],
  id: string,
  now: number,
  name: string,
  role: "volunteer" | "organizer",
) {
  return [
    db
      .prepare(
        `INSERT INTO user (id,name,email,email_verified,role,created_at,updated_at)
    VALUES (?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,
      email_verified=1,two_factor_enabled=0,updated_at=excluded.updated_at`,
      )
      .bind(id, name, `${id}@example.invalid`, role, now, now),
    db
      .prepare(
        `INSERT INTO account (id,user_id,account_id,provider_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(provider_id,account_id) DO NOTHING`,
      )
      .bind(`state-marker:${id}`, id, id, developmentStateProvider, now, now),
  ];
}

function simulatedDiscord(db: Env["DB"], userId: string, completedAt: number) {
  return db
    .prepare(
      `INSERT INTO discord_link
    (user_id,discord_id,username,guild_id,consented_at,completed_at,member_verified_at,next_attempt_at)
    VALUES (?,?,'Simulated local Discord','local-only',?,?,?,?)`,
    )
    .bind(
      userId,
      `local:${userId}`,
      completedAt,
      completedAt,
      completedAt,
      completedAt,
    );
}
