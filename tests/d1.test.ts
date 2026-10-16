import assert from "node:assert/strict";
import { test } from "vitest";
import { env } from "cloudflare:workers";
import { createDatabase } from "../src/server/db";
import { event } from "../src/server/db/schema";
import { changeSignup, listEvents } from "../src/server/db/events";
import { orientationSignupLimitMessage } from "../src/server/db/policy";
import {
  loadApplicationDraft,
  saveApplicationDraft,
} from "../src/server/db/application-drafts";
import {
  hasApplied,
  loadFirstCompletedOrientation,
  loadProfile,
  loadSubmittedApplication,
  saveProfile,
} from "../src/server/db/profiles";
import { codeOfConductVersion } from "../src/data/code-of-conduct";
import type { Actor } from "../src/server/db/access";
import {
  applicationDraftAnswersSchema,
  draftProfileValues,
} from "../src/data/application-draft";
import { RequestError } from "../src/server/http";

test("Drizzle and capacity constraints work in the D1 runtime", async () => {
  const binding = env.DB;
  for (const id of ["organizer", "alice", "bob"]) {
    await binding
      .prepare(
        "INSERT INTO user (id, name, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
      )
      .bind(
        id,
        id,
        `${id}@example.org`,
        id === "organizer" ? "organizer" : "volunteer",
      )
      .run();
  }
  for (const id of ["alice", "bob"]) {
    await binding
      .prepare(
        `INSERT INTO profile (
        user_id, preferred_name, phone, birth_date, emergency_contact_name,
        emergency_contact_phone, emergency_contact_relationship, heard_about_us,
        motivation, teams, medical_certification, training_experience, registered_at, updated_at
      ) VALUES (?, ?, '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', '[]', 'None', 'None', 0, 0)`,
      )
      .bind(id, id)
      .run();
    await binding
      .prepare(
        "INSERT INTO volunteer_status (user_id, registration_approved, updated_at) VALUES (?, 1, 0)",
      )
      .bind(id)
      .run();
  }

  const database = createDatabase(binding);
  const now = new Date();
  await database.insert(event).values({
    id: "orientation",
    type: "orientation",
    starts_at: new Date(now.getTime() + 86_400_000),
    meeting_point: "Meeting point",
    spots: 1,
    created_by: "organizer",
    created_at: now,
    updated_at: now,
  });
  const rows = await database.select().from(event);
  assert.equal(rows[0].starts_at instanceof Date, true);
  assert.equal(rows[0].open, true);

  const attempts = await Promise.allSettled(
    ["alice", "bob"].map((id) =>
      binding
        .prepare(
          "INSERT INTO signup (id, event_id, user_id, created_at, updated_at) VALUES (?, 'orientation', ?, 0, 0)",
        )
        .bind(id, id)
        .run(),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = attempts.find((result) => result.status === "rejected");
  assert.ok(failure?.status === "rejected");
  assert.match(String(failure.reason), /event_full/);
  const count = await binding
    .prepare("SELECT count(*) AS count FROM signup WHERE status = 'confirmed'")
    .first<{ count: number }>();
  assert.equal(count?.count, 1);
});

async function draftActor(id = "draft-volunteer"): Promise<Actor> {
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Unsubmitted', ?, 1, 0, 0)",
  )
    .bind(id, `${id}@example.org`)
    .run();
  await env.DB.prepare(
    "INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
  )
    .bind(`${id}-session`, id, `${id}-token`, Date.now() + 3_600_000)
    .run();
  return {
    id,
    name: "Unsubmitted",
    role: "volunteer",
    sessionId: `${id}-session`,
    twoFactorEnabled: false,
    twoFactorVerified: false,
    applicationSubmitted: false,
    active: false,
    applicationApproved: false,
    patrolApproved: false,
  };
}

const draftInput = (actor: Actor, revision: string | null = null) => ({
  version: 1,
  userId: actor.id,
  revision,
  answers: { firstName: "  Draft name ", birthDate: "2020-01-01" },
});
const statusError = (status: number) => (error: unknown) =>
  error instanceof RequestError && error.status === status;

test("first completed orientation uses the earliest attended event, not when attendance was recorded", async () => {
  const actor = await draftActor();
  const other = await draftActor("other-volunteer");
  const starts = ["2025-01-01", "2025-02-01", "2025-03-01"].map((date) =>
    Date.parse(`${date}T02:00:00Z`),
  );
  await env.DB.batch(
    starts.map((startsAt, index) =>
      env.DB.prepare(
        `INSERT INTO event (id, type, starts_at, meeting_point, spots, created_by, created_at, updated_at)
        VALUES (?, 'orientation', ?, 'Meeting point', 3, ?, 0, 0)`,
      ).bind(`orientation-${index}`, startsAt, actor.id),
    ),
  );
  assert.equal(await loadFirstCompletedOrientation(env.DB, actor.id), null);
  await env.DB.batch(
    [
      [other.id, 0, 1000],
      [actor.id, 2, 2000],
      [actor.id, 1, 3000],
    ].map(([userId, index, markedAt]) =>
      env.DB.prepare(
        "INSERT INTO orientation_completion (id, user_id, event_id, marked_by, marked_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        userId,
        `orientation-${index}`,
        actor.id,
        markedAt,
      ),
    ),
  );
  assert.equal(
    (await loadFirstCompletedOrientation(env.DB, actor.id))?.getTime(),
    starts[1],
  );
});

test("concurrent first-orientation signups reserve one booking; cancellation and past/cancelled events allow rebooking", async () => {
  const actor = {
    ...(await draftActor("orientation-volunteer")),
    applicationSubmitted: true,
    applicationApproved: true,
    active: true,
  };
  const eventIds = ["orientation-one", "orientation-two"];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO profile (
      user_id, preferred_name, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, training_experience, registered_at, updated_at
    ) VALUES (?, 'Volunteer', '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', '[]', 'None', 'None', 0, 0)`,
    ).bind(actor.id),
    env.DB.prepare(
      "INSERT INTO volunteer_status (user_id, registration_approved, updated_at) VALUES (?, 1, 0)",
    ).bind(actor.id),
    ...eventIds.map((id) =>
      env.DB.prepare(
        `INSERT INTO event (id, type, starts_at, meeting_point, spots, created_by, created_at, updated_at)
        VALUES (?, 'orientation', ?, 'Meeting point', 3, ?, 0, 0)`,
      ).bind(id, Date.now() + 86_400_000, actor.id),
    ),
  ]);
  const attempts = await Promise.allSettled(
    eventIds.map((id) => changeSignup(env.DB, actor, id, "join")),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = attempts.find((result) => result.status === "rejected");
  assert.ok(
    failure?.status === "rejected" && failure.reason instanceof RequestError,
  );
  assert.equal(failure.reason.status, 409);
  assert.equal(failure.reason.message, orientationSignupLimitMessage);
  const events = await listEvents(env.DB, actor);
  const booked = events.find((item) => item.signedUp)!;
  const other = events.find((item) => !item.signedUp)!;
  assert.equal(await loadFirstCompletedOrientation(env.DB, actor.id), null);
  assert.equal(other.orientationSignupBlocked, 1);
  await changeSignup(env.DB, actor, booked.id, "cancel");
  assert.ok(
    (await listEvents(env.DB, actor)).every(
      (item) => !item.orientationSignupBlocked,
    ),
  );
  await changeSignup(env.DB, actor, other.id, "join");

  // Hiding/closing does not release the reservation, but event cancellation does.
  await env.DB.prepare("UPDATE event SET open=0, hidden=1 WHERE id=?")
    .bind(other.id)
    .run();
  await assert.rejects(
    changeSignup(env.DB, actor, booked.id, "join"),
    statusError(409),
  );
  await env.DB.prepare("UPDATE event SET cancelled_at=1 WHERE id=?")
    .bind(other.id)
    .run();
  await changeSignup(env.DB, actor, booked.id, "join");
  await env.DB.prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(booked.id)
    .run();
  await env.DB.prepare(
    "UPDATE event SET open=1, hidden=0, cancelled_at=NULL WHERE id=?",
  )
    .bind(other.id)
    .run();
  await changeSignup(env.DB, actor, other.id, "cancel");
  await changeSignup(env.DB, actor, other.id, "join");
});

test("D1 saves partial private drafts without submitting, approving or auditing them", async () => {
  const actor = await draftActor();
  assert.equal(await loadApplicationDraft(env.DB, actor.id), null);
  const saved = await saveApplicationDraft(env.DB, actor, draftInput(actor));
  assert.deepEqual(await loadApplicationDraft(env.DB, actor.id), saved);
  assert.equal(saved.answers.firstName, "  Draft name ");
  assert.equal(await hasApplied(env.DB, actor.id), false);
  assert.equal(
    await env.DB.prepare("SELECT 1 FROM volunteer_status").first(),
    null,
  );
  assert.equal(await env.DB.prepare("SELECT 1 FROM audit_log").first(), null);
  assert.equal(
    await env.DB.prepare("SELECT name FROM user WHERE id=?")
      .bind(actor.id)
      .first("name"),
    "Unsubmitted",
  );
});

test("D1 draft revisions reject stale/concurrent writers and recheck session ownership", async () => {
  const actor = await draftActor();
  const first = await saveApplicationDraft(env.DB, actor, draftInput(actor));
  await assert.rejects(
    saveApplicationDraft(env.DB, actor, draftInput(actor)),
    statusError(409),
  );
  const results = await Promise.allSettled([
    saveApplicationDraft(env.DB, actor, {
      ...draftInput(actor, first.revision),
      answers: { firstName: "Device one" },
    }),
    saveApplicationDraft(env.DB, actor, {
      ...draftInput(actor, first.revision),
      answers: { firstName: "Device two" },
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  await assert.rejects(
    saveApplicationDraft(env.DB, actor, {
      ...draftInput(actor),
      userId: "another-user",
    }),
    statusError(403),
  );
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(actor.sessionId)
    .run();
  const latest = await loadApplicationDraft(env.DB, actor.id);
  await assert.rejects(
    saveApplicationDraft(env.DB, actor, draftInput(actor, latest!.revision)),
    statusError(401),
  );
  assert.deepEqual(await loadApplicationDraft(env.DB, actor.id), latest);
});

test("submission atomically removes drafts; failed submissions retain them and late autosaves cannot recreate them", async () => {
  const actor = await draftActor();
  const saved = await saveApplicationDraft(env.DB, actor, draftInput(actor));
  await assert.rejects(saveProfile(env.DB, actor.id, {}), statusError(400));
  assert.deepEqual(await loadApplicationDraft(env.DB, actor.id), saved);
  const answers = draftProfileValues(
    applicationDraftAnswersSchema.parse({
      firstName: "Draft",
      lastName: "Volunteer",
      phone: "604-555-0100",
      birthDate: "1995-01-01",
      emergencyName: "Contact",
      emergencyPhone: "604-555-0101",
      emergencyRelationship: "Friend",
      heardAboutUsSources: ["internet"],
      motivation: "I want to help.",
    }),
  );
  await saveProfile(env.DB, actor.id, {
    ...answers,
    codeOfConductAccepted: true,
  });
  const submission = await loadSubmittedApplication(env.DB, actor.id);
  assert.ok(submission);
  assert.deepEqual(submission.answers, answers);
  assert.equal(submission.email, `${actor.id}@example.org`);
  assert.equal(submission.codeOfConductVersion, codeOfConductVersion);
  const context = await env.DB.prepare(
    "SELECT registered_at, code_of_conduct_accepted_at FROM profile WHERE user_id=?",
  )
    .bind(actor.id)
    .first();
  assert.equal(Date.parse(submission.submittedAt), context?.registered_at);
  assert.equal(
    Date.parse(submission.codeOfConductAcceptedAt),
    context?.code_of_conduct_accepted_at,
  );
  await env.DB.prepare("UPDATE user SET email=? WHERE id=?")
    .bind("changed@example.org", actor.id)
    .run();
  await saveProfile(env.DB, actor.id, {
    ...answers,
    preferredName: "Changed nickname",
    phone: "604-555-0199",
    emergencyName: "Changed contact",
    medicalConditions: "Changed safety answer",
    teams: ["non-patrol"],
    training: ["naloxone-administration"],
  });
  assert.equal((await loadProfile(env.DB, actor.id))?.phone, "604-555-0199");
  assert.deepEqual(
    await loadSubmittedApplication(env.DB, actor.id),
    submission,
  );
  assert.equal(await loadSubmittedApplication(env.DB, "another-user"), null);
  await assert.rejects(
    env.DB.prepare(
      "UPDATE profile SET submitted_application=NULL WHERE user_id=?",
    )
      .bind(actor.id)
      .run(),
    /submitted_application_immutable/,
  );
  assert.equal(await loadApplicationDraft(env.DB, actor.id), null);
  for (const revision of [saved.revision, null])
    await assert.rejects(
      saveApplicationDraft(env.DB, actor, draftInput(actor, revision)),
      statusError(410),
    );
});

test("deleting an account cascades to its private application draft", async () => {
  const actor = await draftActor();
  await saveApplicationDraft(env.DB, actor, draftInput(actor));
  await env.DB.prepare("DELETE FROM user WHERE id=?").bind(actor.id).run();
  assert.equal(await loadApplicationDraft(env.DB, actor.id), null);
});
