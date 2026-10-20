import assert from "node:assert/strict";
import { test } from "vitest";
import { env } from "cloudflare:workers";
import { localEventFixtures } from "../scripts/local-event-fixtures";
import { localAccountFixtures } from "../scripts/local-account-fixtures";
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
import {
  listVolunteers,
  setVolunteerStatus,
  viewVolunteerProfile,
  volunteerPageSize,
} from "../src/server/db/volunteers";
import {
  medicNotificationDates,
  pendingMedicNotifications,
  queueMedicCertificationNotifications,
} from "../src/server/db/medic-certifications";
import { processMedicCertificationNotifications } from "../src/server/medic-certifications";
import {
  createDisposableAccount,
  deleteLocalAccount,
} from "../src/dev/server/local-accounts";

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

test("application queue counts all submitted unapproved applications independently of search, pages and profile views", async () => {
  const actor: Actor = {
    ...(await draftActor("queue-organizer")),
    role: "organizer",
    applicationSubmitted: true,
    active: true,
    applicationApproved: true,
  };
  await env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
    .bind(actor.id)
    .run();
  const ids = [
    actor.id,
    "approved",
    ...Array.from(
      { length: volunteerPageSize + 3 },
      (_, index) => `pending-${String(index).padStart(2, "0")}`,
    ),
  ];
  for (const id of ids) {
    if (id !== actor.id) await draftActor(id);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO profile (
        user_id, preferred_name, phone, birth_date, emergency_contact_name,
        emergency_contact_phone, emergency_contact_relationship, heard_about_us,
        motivation, teams, medical_certification, training_experience, registered_at, updated_at
      ) VALUES (?, ?, '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', '[]', 'None', 'None', 0, 0)`,
      ).bind(id, id),
      env.DB.prepare(
        "INSERT INTO volunteer_status (user_id, active, registration_approved, patrol_approved, approved_by, approved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0)",
      ).bind(
        id,
        id === "pending-00" ? 0 : 1,
        id.startsWith("pending-") ? 0 : 1,
        id === "pending-01" ? 1 : 0,
        id === "pending-01" ? actor.id : null,
        id === "pending-01" ? 0 : null,
      ),
    ]);
  }
  const draft = await draftActor("draft-only");
  await saveApplicationDraft(env.DB, draft, draftInput(draft));
  await draftActor("account-only");
  // Even an anomalous account-only status cannot count without submission.
  await env.DB.prepare(
    "INSERT INTO volunteer_status (user_id, updated_at) VALUES ('account-only', 0)",
  ).run();
  const count = volunteerPageSize + 3;
  const first = await listVolunteers(env.DB, actor, "", 0, "awaiting");
  assert.equal(first.awaitingApprovalCount, count);
  assert.equal(first.rows.length, volunteerPageSize);
  assert.equal(first.hasMore, true);
  assert.equal(first.rows[0].active, 0); // Inactive is not an approval state.
  assert.equal(first.rows[1].patrolApproved, 1); // Neither is patrol approval.
  const second = await listVolunteers(
    env.DB,
    actor,
    "",
    volunteerPageSize,
    "awaiting",
  );
  assert.equal(second.awaitingApprovalCount, count);
  assert.equal(second.rows.length, 3);
  assert.equal(second.hasMore, false);
  assert.equal(
    new Set([...first.rows, ...second.rows].map((row) => row.id)).size,
    count,
  );
  for (const search of ["pending-02", "no match", "approved"])
    assert.equal(
      (await listVolunteers(env.DB, actor, search, 0, "awaiting"))
        .awaitingApprovalCount,
      count,
    );
  assert.deepEqual(
    (await listVolunteers(env.DB, actor, "approved", 0, "awaiting")).rows,
    [],
  );
  assert.equal(
    (await listVolunteers(env.DB, actor, "approved")).rows[0].id,
    "approved",
  );
  assert.equal(
    await env.DB.prepare("SELECT count(*) FROM audit_log").first("count(*)"),
    0,
  );
  await viewVolunteerProfile(env.DB, actor, "pending-02");
  assert.equal(
    (await listVolunteers(env.DB, actor, "pending-02", 0, "awaiting")).rows
      .length,
    1,
  );
  assert.equal(
    (await listVolunteers(env.DB, actor)).awaitingApprovalCount,
    count,
  );
  assert.equal(
    await env.DB.prepare("SELECT action FROM audit_log").first("action"),
    "profile_viewed",
  );
  await setVolunteerStatus(env.DB, actor, {
    userId: "pending-02",
    version: 0,
    active: true,
    applicationApproved: true,
    patrolApproved: false,
  });
  const after = await listVolunteers(
    env.DB,
    actor,
    "pending-02",
    0,
    "awaiting",
  );
  assert.deepEqual(after.rows, []);
  assert.equal(after.awaitingApprovalCount, count - 1);
  assert.equal(
    (await listVolunteers(env.DB, actor, "pending-02")).rows[0]
      .applicationApproved,
    1,
  );
  const version = (await listVolunteers(env.DB, actor, "pending-02")).rows[0]
    .updatedAt;
  await setVolunteerStatus(env.DB, actor, {
    userId: "pending-02",
    version,
    active: true,
    applicationApproved: false,
    patrolApproved: false,
  });
  assert.equal(
    (await listVolunteers(env.DB, actor, "pending-02", 0, "awaiting"))
      .awaitingApprovalCount,
    count,
  );
  for (const denied of [
    { ...actor, role: "volunteer" as const },
    { ...actor, active: false },
    { ...actor, applicationSubmitted: false },
    { ...actor, twoFactorEnabled: true, twoFactorVerified: false },
  ])
    await assert.rejects(
      listVolunteers(env.DB, denied, "", 0, "awaiting"),
      statusError(403),
    );
  // Organizer event access is a role exception, not application approval.
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  const organizerQueue = await listVolunteers(
    env.DB,
    { ...actor, applicationApproved: false },
    "queue-organizer",
    0,
    "awaiting",
  );
  assert.equal(organizerQueue.awaitingApprovalCount, count + 1);
  assert.equal(organizerQueue.rows[0].id, actor.id);
});

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
      teams: ["outreach"],
      training: ["none"],
    }),
  );
  await assert.rejects(
    saveProfile(env.DB, actor.id, {
      ...answers,
      teams: [],
      codeOfConductAccepted: true,
    }),
    statusError(400),
  );
  assert.deepEqual(await loadApplicationDraft(env.DB, actor.id), saved);
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
    teams: ["outreach", "non-patrol"],
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

test("new local applications preserve old fixtures; deletion protects only manual presets, last organizers and references", async () => {
  const original = await draftActor("local-account-user-not-applied");
  const answers = {
    ...draftProfileValues(
      applicationDraftAnswersSchema.parse({
        firstName: "Preserved",
        lastName: "Application",
        phone: "604-555-0100",
        birthDate: "1995-01-01",
        emergencyName: "Contact",
        emergencyPhone: "604-555-0101",
        emergencyRelationship: "Friend",
        heardAboutUsSources: ["internet"],
        motivation: "I want to help.",
        teams: ["outreach"],
        training: ["none"],
      }),
    ),
    codeOfConductAccepted: true,
  };
  await saveProfile(env.DB, original.id, answers);
  const snapshot = await loadSubmittedApplication(env.DB, original.id);
  const fresh = await createDisposableAccount(env.DB);
  await createDisposableAccount(env.DB);
  assert.equal(await loadProfile(env.DB, fresh), null);
  assert.equal(await loadApplicationDraft(env.DB, fresh), null);
  assert.equal(await deleteLocalAccount(env.DB, fresh), true);
  assert.deepEqual(
    await loadSubmittedApplication(env.DB, original.id),
    snapshot,
  );
  // Ordinary sign-in accounts have neither the application prefix nor a marker.
  const { id } = await draftActor("ordinary-local-account");
  await saveProfile(env.DB, id, answers);
  const organizer = await draftActor("protected-organizer");
  await saveProfile(env.DB, organizer.id, answers);
  await env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
    .bind(organizer.id)
    .run();
  await assert.rejects(
    deleteLocalAccount(env.DB, organizer.id),
    (error: unknown) =>
      error instanceof Error &&
      /last_organizer/.test(`${error.message} ${error.cause}`),
  );
  assert.ok(await loadProfile(env.DB, organizer.id));
  // An unreferenced organizer can be deleted while another active one remains.
  await env.DB.prepare(
    "UPDATE user SET role='organizer', name='1 1', email='changed@example.org' WHERE id=?",
  )
    .bind(id)
    .run();
  await env.DB.prepare(
    `INSERT INTO event (id, type, starts_at, meeting_point, spots, created_by, created_at, updated_at)
    VALUES ('protected-event', 'orientation', 0, 'Meeting point', 1, ?, 0, 0)`,
  )
    .bind(id)
    .run();
  const audit = () =>
    env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE subject_id=?")
      .bind(id)
      .first();
  const before = await audit();
  await assert.rejects(deleteLocalAccount(env.DB, id));
  assert.deepEqual(await audit(), before); // No partial child deletion on FK failure.
  assert.ok(await loadProfile(env.DB, id));
  assert.equal(
    await env.DB.prepare("SELECT role FROM user WHERE id=?")
      .bind(id)
      .first("role"),
    "organizer",
  );
  await env.DB.prepare("DELETE FROM event WHERE id='protected-event'").run();
  assert.equal(await deleteLocalAccount(env.DB, id), true);
  assert.equal(await loadProfile(env.DB, id), null);
  assert.deepEqual(
    await loadSubmittedApplication(env.DB, original.id),
    snapshot,
  );
  // The saved old Not applied fixture is deletable too, unlike the virtual choice.
  assert.equal(await deleteLocalAccount(env.DB, original.id), true);
  assert.equal(await loadSubmittedApplication(env.DB, original.id), null);
  assert.equal(await deleteLocalAccount(env.DB, original.id), false);
  await env.DB.batch(localEventFixtures().map((sql) => env.DB.prepare(sql)));
  assert.equal(
    await deleteLocalAccount(env.DB, "local-fixture-user-casey"),
    true,
  );
  assert.equal(await loadProfile(env.DB, "local-fixture-user-casey"), null);
  await env.DB.batch(localAccountFixtures().map((sql) => env.DB.prepare(sql)));
  // Renaming a preset cannot remove protection; ordinary names/roles above do not add it.
  await env.DB.prepare(
    "UPDATE user SET name='Renamed preset' WHERE id LIKE 'local-account-user-%'",
  ).run();
  const snapshotTables = () =>
    Promise.all(
      ["user", "profile", "volunteer_status", "session", "audit_log"].map(
        async (table) =>
          (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
            .results,
      ),
    );
  const beforePresets = await snapshotTables();
  for (const key of ["applied", "accepted", "inactive", "organizer"]) {
    await assert.rejects(
      deleteLocalAccount(env.DB, `local-account-user-${key}`),
      statusError(403),
    );
    assert.deepEqual(await snapshotTables(), beforePresets);
  }
});

async function seedMedic(
  id: string,
  expiry: string,
  {
    active = 1,
    verified = 1,
    teams = '["medic"]',
    certifications = '["advanced-first-aid"]',
  } = {},
) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Medic', ?, ?, 0, 0)",
    ).bind(id, `${id}@example.org`, verified),
    env.DB.prepare(
      `INSERT INTO profile (
      user_id, preferred_name, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, medical_certifications, medical_certification_expiry,
      training_experience, registered_at, updated_at
    ) VALUES (?, 'Medic', '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', ?, 'Legacy text', ?, ?, 'None', 0, 0)`,
    ).bind(id, teams, certifications, expiry),
    env.DB.prepare(
      "INSERT INTO volunteer_status (user_id, active, updated_at) VALUES (?, ?, 0)",
    ).bind(id, active),
  ]);
}

test("medic reminder dates respect Vancouver midnight/DST, expiry day, 30-day warning and bounded catch-up", async () => {
  const now = Date.parse("2026-10-16T06:59:59Z"); // Still October 15 in Vancouver.
  assert.deepEqual(medicNotificationDates(now), {
    today: "2026-10-15",
    warningThrough: "2026-11-14",
    expiredSince: "2026-10-08",
  });
  assert.equal(
    medicNotificationDates(Date.parse("2026-11-01T07:00:00Z")).today,
    "2026-11-01",
  );
  assert.equal(
    medicNotificationDates(Date.parse("2026-11-01T10:00:00Z")).warningThrough,
    "2026-12-01",
  );
  assert.equal(
    medicNotificationDates(Date.parse("2028-02-29T08:00:00Z")).warningThrough,
    "2028-03-30",
  );
  await seedMedic("warning", "2026-11-14");
  await seedMedic("too-early", "2026-11-15");
  await seedMedic("expiry-day", "2026-10-15");
  await seedMedic("yesterday", "2026-10-14");
  await seedMedic("seven-days", "2026-10-08");
  await seedMedic("ancient", "2020-01-01");
  await seedMedic("eight-days", "2026-10-07");
  await seedMedic("inactive", "2026-11-14", { active: 0 });
  await seedMedic("unverified", "2026-11-14", { verified: 0 });
  await seedMedic("outreach", "2026-11-14", { teams: '["outreach"]' });
  await seedMedic("free-text-only", "2026-11-14", { certifications: "[]" });
  await seedMedic("unknown-cert", "2026-11-14", {
    certifications: '["unknown"]',
  });
  await seedMedic("bad-json", "2026-11-14", { certifications: "not json" });
  await seedMedic("bad-date", "2026-11-00");
  assert.equal(await queueMedicCertificationNotifications(env.DB, now), 4);
  assert.equal(await queueMedicCertificationNotifications(env.DB, now), 0);
  const rows = await env.DB.prepare(
    "SELECT user_id, kind FROM medic_certification_notification ORDER BY user_id",
  ).all();
  assert.deepEqual(rows.results, [
    { user_id: "expiry-day", kind: "warning" },
    { user_id: "seven-days", kind: "expired" },
    { user_id: "warning", kind: "warning" },
    { user_id: "yesterday", kind: "expired" },
  ]);
  await queueMedicCertificationNotifications(env.DB, now + 1000);
  const due = await pendingMedicNotifications(env.DB, now + 1000, 20);
  assert.equal(
    due.some(
      (row) => row.email === "expiry-day@example.org" && row.kind === "expired",
    ),
    true,
  );
  assert.equal(
    due.some(
      (row) => row.email === "expiry-day@example.org" && row.kind === "warning",
    ),
    false,
  );
});

test("medic mail deduplicates concurrent runs and renewals; ambiguous retries freeze payload and stop before Resend keys expire", async () => {
  const now = Date.parse("2026-10-15T16:00:00Z");
  const bindings = {
    DB: env.DB,
    APP_ENV: "production",
    AUTH_BASE_URL: "https://afterhoursoutreach.ca",
    BETTER_AUTH_SECRET: "runtime-only-medic-test-secret",
    RESEND_API_KEY: "test-only-resend-key",
  };
  await seedMedic("medic", "2026-11-14");
  const payloads = new Map<string, string>();
  let calls = 0;
  let loseResponse = false;
  const provider: typeof fetch = async (_input, init) => {
    calls++;
    const key = new Headers(init?.headers).get("Idempotency-Key")!;
    const body = String(init?.body);
    if (payloads.has(key)) assert.equal(body, payloads.get(key));
    payloads.set(key, body); // Simulated provider accepts once for each key.
    if (loseResponse)
      throw new Error("Simulated response lost after acceptance");
    return new Response(null, { status: 200 });
  };
  const run = (discover = true, time = now) =>
    processMedicCertificationNotifications(bindings, discover, provider, time);
  await Promise.all([run(), run()]);
  await run();
  assert.equal(calls, 1);
  assert.equal(payloads.size, 1);
  assert.match([...payloads.values()][0], /2026-11-14/);
  assert.match([...payloads.values()][0], /noreply@afterhoursoutreach.ca/);

  await env.DB.prepare(
    "UPDATE profile SET medical_certification_expiry='2026-11-13' WHERE user_id='medic'",
  ).run();
  loseResponse = true;
  await run();
  assert.equal(payloads.size, 2); // Renewal has its own warning cycle.
  loseResponse = false;
  bindings.AUTH_BASE_URL = "https://changed.example.org";
  await run(false, now + 3_600_000);
  assert.equal(payloads.size, 2); // Same provider key AND frozen original origin/payload.
  assert.equal(calls, 3);
  assert.equal(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM medic_certification_notification WHERE status='sent'",
    ).first("count"),
    2,
  );
  assert.equal(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM medic_certification_notification WHERE delivery_payload IS NOT NULL",
    ).first("count"),
    0,
  );

  await env.DB.prepare(
    "UPDATE profile SET medical_certification_expiry='2026-11-12' WHERE user_id='medic'",
  ).run();
  loseResponse = true;
  await run();
  await run(false, now + 23 * 3_600_000);
  await run(true, now + 24 * 3_600_000);
  assert.equal(calls, 4); // Never re-send an ambiguous request after the safe retry window.
  assert.equal(
    await env.DB.prepare(
      "SELECT status FROM medic_certification_notification WHERE expiry='2026-11-12'",
    ).first("status"),
    "expired",
  );

  await env.DB.prepare(
    "UPDATE profile SET medical_certification_expiry='2026-11-11' WHERE user_id='medic'",
  ).run();
  await queueMedicCertificationNotifications(env.DB, now);
  await env.DB.prepare(
    "UPDATE volunteer_status SET active=0 WHERE user_id='medic'",
  ).run();
  await run(false);
  assert.equal(calls, 4);
  assert.equal(
    await env.DB.prepare(
      "SELECT status FROM medic_certification_notification WHERE expiry='2026-11-11'",
    ).first("status"),
    "cancelled",
  );
  await processMedicCertificationNotifications(
    { ...bindings, APP_ENV: "local" },
    true,
    provider,
    now,
  );
  await processMedicCertificationNotifications(
    { ...bindings, APP_ENV: "preview" },
    true,
    provider,
    now,
  );
  assert.equal(calls, 4);
});
