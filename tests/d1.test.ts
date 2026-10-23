import assert from "node:assert/strict";
import { test } from "vitest";
import { env } from "cloudflare:workers";
import { localEventFixtures } from "../scripts/local-event-fixtures";
import { localAccountFixtures } from "../scripts/local-account-fixtures";
import { createDatabase } from "../src/server/db";
import { event } from "../src/server/db/schema";
import {
  changeSignup,
  listEvents,
  listPublicRosters,
  manageSignup,
} from "../src/server/db/events";
import { orientationSignupLimitMessage } from "../src/server/db/policy";
import {
  loadApplicationDraft,
  saveApplicationDraft,
  discardApplicationDraft,
  loadApplicationDraftState,
} from "../src/server/db/application-drafts";
import {
  hasApplied,
  loadFirstCompletedOrientation,
  loadProfile,
  loadSubmittedApplication,
  saveProfile,
} from "../src/server/db/profiles";
import { codeOfConductVersion } from "../src/data/code-of-conduct";
import {
  isApplicationComplete,
  loadApplicationProgress,
} from "../src/server/db/application-progress";
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
import { deliverNotifications } from "../src/server/events/notifications";
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
  await binding
    .prepare(
      "UPDATE volunteer_status SET patrol_approved=1,approved_by='organizer',approved_at=0",
    )
    .run();
  const now = new Date();
  await database.insert(event).values({
    id: "orientation",
    type: "patrol",
    starts_at: new Date(now.getTime() + 86_400_000),
    meeting_point: "Meeting point",
    spots: 3,
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
  assert.match(String(failure.reason), /signup_places_reserved/);
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
    applicationComplete: false,
    naloxoneCompleted: false,
    active: false,
    applicationApproved: false,
    patrolApproved: false,
  };
}

test("concurrent D1 registrations preserve both reservations; cancellations and failed organizer moves are atomic", async () => {
  const organizer = {
    ...(await draftActor("organizer")),
    role: "organizer" as const,
    applicationSubmitted: true,
    active: true,
    applicationApproved: true,
  };
  await env.DB.prepare(
    "UPDATE user SET role='organizer' WHERE id='organizer'",
  ).run();
  await env.DB.batch(
    ["history", "target", "source"].map((id) =>
      env.DB.prepare(
        `INSERT INTO event
    (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
    VALUES (?, 'orientation', ?, 'Point', ?, 'organizer',0,0)`,
      ).bind(
        id,
        id === "history" ? 0 : Date.now() + 86_400_000,
        id === "target" ? 5 : 8,
      ),
    ),
  );
  const people: Actor[] = [];
  for (const id of [
    "general-1",
    "general-2",
    "orientee-1",
    "orientee-2",
    "orientee-3",
    "medic-1",
    "medic-2",
    "medic-3",
  ]) {
    const actor = {
      ...(await draftActor(id)),
      applicationSubmitted: true,
      active: true,
      applicationApproved: true,
      patrolApproved: true,
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO profile (user_id,first_name,last_name,preferred_name,phone,birth_date,emergency_contact_name,
        emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,training_experience,registered_at,updated_at)
        VALUES (?, 'Alice', 'PrivateSurname', 'PRIVATE FULL NAME', 'PRIVATE PHONE','2000-01-01','PRIVATE CONTACT','555','Friend','Friend','Help',?,'PRIVATE CERT','None',0,0)`,
      ).bind(id, id.startsWith("medic") ? '["medic"]' : "[]"),
      env.DB.prepare(
        "INSERT INTO volunteer_status (user_id,registration_approved,patrol_approved,approved_by,approved_at,updated_at) VALUES (?,1,1,'organizer',0,0)",
      ).bind(id),
    ]);
    if (!id.startsWith("orientee"))
      await env.DB.prepare(
        "INSERT INTO orientation_completion VALUES (?,?, 'history','organizer',0)",
      )
        .bind(`${id}-completion`, id)
        .run();
    people.push(actor);
  }
  const generals = await Promise.allSettled(
    people
      .slice(0, 2)
      .map((actor) => changeSignup(env.DB, actor, "target", "join")),
  );
  assert.equal(
    generals.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const reserved = await Promise.allSettled(
    people
      .slice(2)
      .map((actor) => changeSignup(env.DB, actor, "target", "join")),
  );
  assert.equal(
    reserved.filter((result) => result.status === "fulfilled").length,
    4,
  );
  const target = (
    await listEvents(env.DB, people[0], undefined, "volunteer")
  ).find((row) => row.id === "target")!;
  assert.deepEqual(
    [target.confirmed, target.medicConfirmed, target.orientationConfirmed],
    [5, 2, 2],
  );
  const roster = await listPublicRosters(env.DB, people[0], [
    "target",
    "history",
    ...Array.from({ length: 98 }, (_, index) => `unlisted-${index}`),
  ]);
  assert.equal(roster.people.length, 5);
  assert.ok(
    roster.people.every(
      (row) =>
        row.name === "Alice P." &&
        Object.keys(row).sort().join() === "category,eventId,name",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(roster),
    /PRIVATE|PrivateSurname|medic-[123]|general-[12]/,
  );
  await assert.rejects(
    listPublicRosters(env.DB, { ...people[0], applicationApproved: false }, [
      "target",
    ]),
    statusError(403),
  );
  const general = people[generals[0].status === "rejected" ? 0 : 1];
  const bookedGeneral = people[generals[0].status === "fulfilled" ? 0 : 1];
  // Same signup, abbreviated name and category: reassignment must still change
  // the opaque version, never the safe projection or expose either identity.
  await env.DB.prepare(
    "UPDATE signup SET user_id=? WHERE event_id='target' AND user_id=? AND status='confirmed'",
  )
    .bind(general.id, bookedGeneral.id)
    .run();
  const swapped = await listPublicRosters(env.DB, people[0], ["target"]);
  assert.deepEqual(swapped.people, roster.people);
  assert.notEqual(swapped.version, roster.version);
  await env.DB.prepare(
    "UPDATE signup SET user_id=? WHERE event_id='target' AND user_id=? AND status='confirmed'",
  )
    .bind(bookedGeneral.id, general.id)
    .run();
  const medic = people.find(
    (_actor, index) => index >= 5 && reserved[index - 2].status === "fulfilled",
  )!;
  await changeSignup(env.DB, medic, "target", "cancel");
  await changeSignup(env.DB, general, "source", "join");
  const source = await env.DB.prepare(
    "SELECT id FROM signup WHERE event_id='source' AND status='confirmed'",
  ).first<string>("id");
  const audits = await env.DB.prepare(
    "SELECT count(*) n FROM event_audit",
  ).first<number>("n");
  await assert.rejects(
    manageSignup(env.DB, organizer, source!, "target", "", true),
    statusError(409),
  );
  assert.equal(
    await env.DB.prepare("SELECT status FROM signup WHERE id=?")
      .bind(source)
      .first("status"),
    "confirmed",
  );
  assert.equal(
    await env.DB.prepare("SELECT count(*) n FROM event_audit").first("n"),
    audits,
  );
  assert.equal(
    await env.DB.prepare("SELECT count(*) n FROM event_notification").first(
      "n",
    ),
    0,
  );
  await changeSignup(env.DB, medic, "target", "join");
  const orientee = people.find(
    (_actor, index) =>
      index >= 2 && index < 5 && reserved[index - 2].status === "fulfilled",
  )!;
  await changeSignup(env.DB, orientee, "target", "cancel");
  await assert.rejects(
    changeSignup(env.DB, general, "target", "join"),
    statusError(409),
  );
  await changeSignup(env.DB, orientee, "target", "join");
});

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
  const profile = await viewVolunteerProfile(env.DB, actor, "pending-02");
  assert.equal(profile?.email, "pending-02@example.org");
  assert.equal(profile?.answers.preferredName, "pending-02");
  assert.equal(profile?.submittedAt, "1970-01-01T00:00:00.000Z");
  // Legacy profiles have no recorded acknowledgement; never invent one.
  assert.equal(profile?.codeOfConductVersion, null);
  assert.equal(profile?.codeOfConductAcceptedAt, null);
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
  const approval = await setVolunteerStatus(env.DB, actor, {
    userId: "pending-02",
    version: 0,
    active: true,
    applicationApproved: true,
    patrolApproved: false,
    notify: true,
  });
  await deliverNotifications(
    {
      ...env,
      APP_ENV: "local",
      AUTH_BASE_URL: "https://afterhoursoutreach.ca",
    },
    approval.operation,
  );
  const payload = await env.DB.prepare(
    "SELECT payload FROM event_notification_batch WHERE operation_id=?",
  )
    .bind(approval.operation)
    .first<string>("payload");
  const approvalEmails = JSON.parse(payload!) as {
    subject: string;
    text: string;
  }[];
  assert.equal(approvalEmails.length, 1);
  assert.equal(
    approvalEmails[0].subject,
    "Your volunteer application is approved",
  );
  assert.match(approvalEmails[0].text, /Thanks for joining us/);
  assert.match(
    approvalEmails[0].text,
    /If Naloxone 101 completion is not yet confirmed, return to the Volunteer page, complete the course if needed, and confirm completion only after finishing it/,
  );
  assert.match(
    approvalEmails[0].text,
    /Once completion is confirmed, choose an "Orientation \+ Patrol" event/,
  );
  assert.doesNotMatch(approvalEmails[0].text, /Includes orientation/);
  assert.match(
    approvalEmails[0].text,
    /separate organizer approval for patrols without orientation/,
  );
  assert.match(
    approvalEmails[0].text,
    /Events: https:\/\/afterhoursoutreach\.ca\/events$/,
  );
  for (const [active, patrolApproved, guidance] of [
    [
      false,
      false,
      /currently inactive.*contact an organizer before registering/,
    ],
    [true, true, /browse upcoming patrols and register for an available spot/],
    [
      true,
      false,
      /If Naloxone 101 completion is not yet confirmed.*Volunteer page.*only after finishing it.*Once completion is confirmed.*"Orientation \+ Patrol"/,
    ],
  ] as const) {
    const current = (await listVolunteers(env.DB, actor, "pending-02")).rows[0];
    const accessChange = await setVolunteerStatus(env.DB, actor, {
      userId: current.id,
      version: current.updatedAt,
      active,
      patrolApproved,
      notify: true,
    });
    const email = await env.DB.prepare(
      "SELECT subject, body, delivery_to AS recipient FROM event_notification WHERE operation_id=?",
    )
      .bind(accessChange.operation)
      .first<{ subject: string; body: string; recipient: string }>();
    assert.equal(
      email?.subject,
      "Your After Hours Outreach volunteer access changed",
    );
    assert.equal(email?.recipient, "pending-02@example.org");
    assert.match(email!.body, guidance);
    assert.doesNotMatch(
      email!.body,
      /Includes orientation|Sign in to view your events/,
    );
    // Patrol-approved legacy profiles need no new course confirmation.
    if (patrolApproved)
      assert.doesNotMatch(email!.body, /Naloxone|Volunteer page/);
  }
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
  const revocation = await setVolunteerStatus(env.DB, actor, {
    userId: "pending-02",
    version,
    active: true,
    applicationApproved: false,
    patrolApproved: false,
    notify: true,
  });
  const revokedEmail = await env.DB.prepare(
    "SELECT subject, body FROM event_notification WHERE operation_id=?",
  )
    .bind(revocation.operation)
    .first<{ subject: string; body: string }>();
  assert.equal(
    revokedEmail?.subject,
    "Your volunteer application approval was revoked",
  );
  assert.match(revokedEmail!.body, /awaiting organizer approval again/);
  assert.match(revokedEmail!.body, /application steps on the Volunteer page/);
  assert.match(revokedEmail!.body, /Check Your account for any changes/);
  assert.doesNotMatch(
    revokedEmail!.body,
    /check your events|register for an available spot/,
  );
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
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(actor.sessionId)
    .run();
  await assert.rejects(
    viewVolunteerProfile(env.DB, actor, "pending-02"),
    statusError(403),
  ); // A stale organizer actor cannot disclose email or application answers.
});

const completeAnswers = () =>
  draftProfileValues(
    applicationDraftAnswersSchema.parse({
      firstName: "Volunteer",
      lastName: "Applicant",
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

test("drafts merge independent concurrent edits, reject same-field changes, and retry lost responses", async () => {
  const actor = await draftActor();
  const first = await saveApplicationDraft(env.DB, actor, draftInput(actor));
  const request = {
    ...draftInput(actor, first.revision),
    baseline: first.answers,
  };
  await Promise.all([
    saveApplicationDraft(env.DB, actor, {
      ...request,
      answers: { ...first.answers, phone: "local phone" },
    }),
    saveApplicationDraft(env.DB, actor, {
      ...request,
      answers: { ...first.answers, pronouns: "remote pronouns" },
    }),
  ]);
  const merged = (await loadApplicationDraft(env.DB, actor.id))!;
  assert.equal(merged.answers.phone, "local phone");
  assert.equal(merged.answers.pronouns, "remote pronouns");
  await saveApplicationDraft(env.DB, actor, {
    ...request,
    answers: { ...first.answers, phone: "local phone" },
  });
  assert.deepEqual(
    (await loadApplicationDraft(env.DB, actor.id))?.answers,
    merged.answers,
  );
  await assert.rejects(
    saveApplicationDraft(env.DB, actor, {
      ...request,
      answers: { ...first.answers, phone: "different phone" },
    }),
    statusError(409),
  );
});

test("profile edits merge independent fields, retain same-field input for explicit choice, and retry without duplicate audit", async () => {
  const actor = await draftActor();
  const baseline = completeAnswers();
  await saveProfile(env.DB, actor.id, {
    ...baseline,
    codeOfConductAccepted: true,
  });
  const [one, two] = await Promise.all([
    saveProfile(
      env.DB,
      actor.id,
      { ...baseline, phone: "604-555-0111" },
      { actor, baseline, intent: "edit" },
    ),
    saveProfile(
      env.DB,
      actor.id,
      { ...baseline, pronouns: "they/them" },
      { actor, baseline, intent: "edit" },
    ),
  ]);
  assert.equal(one.firstSubmitted, false);
  assert.equal(two.firstSubmitted, false);
  const latest = (await loadProfile(env.DB, actor.id))!;
  assert.equal(latest.phone, "604-555-0111");
  assert.equal(latest.pronouns, "they/them");
  const audits = () =>
    env.DB.prepare("SELECT count(*) FROM audit_log WHERE subject_id=?")
      .bind(actor.id)
      .first("count(*)");
  const count = await audits();
  await saveProfile(
    env.DB,
    actor.id,
    { ...baseline, phone: "604-555-0111" },
    { baseline, intent: "edit" },
  );
  assert.equal(await audits(), count);
  await assert.rejects(
    saveProfile(
      env.DB,
      actor.id,
      { ...baseline, phone: "604-555-0122" },
      { baseline, intent: "edit" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RequestError && error.status === 409);
      assert.deepEqual(error.details?.latest, latest);
      return true;
    },
  );
  await saveProfile(
    env.DB,
    actor.id,
    { ...latest, phone: "604-555-0122" },
    { baseline: latest, intent: "edit" },
  );
  assert.equal((await loadProfile(env.DB, actor.id))?.phone, "604-555-0122");
  await assert.rejects(
    saveProfile(env.DB, actor.id, baseline),
    statusError(428),
  );
  const beforeRetry = (await loadProfile(env.DB, actor.id))!;
  const padded = { ...beforeRetry, preferredName: "  Trimmed retry  " };
  await saveProfile(env.DB, actor.id, padded, {
    baseline: beforeRetry,
    intent: "edit",
  });
  const retryAudits = await audits();
  await saveProfile(env.DB, actor.id, padded, {
    baseline: beforeRetry,
    intent: "edit",
  });
  assert.equal(await audits(), retryAudits);
  assert.equal(
    (await loadProfile(env.DB, actor.id))?.preferredName,
    "Trimmed retry",
  );
});

test("concurrent first submissions are insert-only and durable first-submission intents run once", async () => {
  const actor = await draftActor();
  const answers = completeAnswers();
  // A stand-in intent in an existing table tests the transaction contract without
  // implementing notification delivery or requiring a schema change.
  const options = {
    actor,
    intent: "submit" as const,
    firstSubmissionStatements: ({
      operationId,
      writeGuard,
    }: {
      operationId: string;
      writeGuard: string;
    }) => [
      env.DB.prepare(
        `INSERT INTO audit_log (id,actor_id,subject_id,action,changed_fields,created_at) SELECT ?,?,?,'submission_intent','[]',0 WHERE ${writeGuard}`,
      ).bind(crypto.randomUUID(), actor.id, actor.id, operationId),
    ],
  };
  const results = await Promise.all([
    saveProfile(
      env.DB,
      actor.id,
      { ...answers, codeOfConductAccepted: true },
      options,
    ),
    saveProfile(
      env.DB,
      actor.id,
      { ...answers, phone: "604-555-0199", codeOfConductAccepted: true },
      options,
    ),
  ]);
  assert.equal(results.filter((result) => result.firstSubmitted).length, 1);
  const winner = results.find((result) => result.firstSubmitted)!;
  assert.deepEqual(await loadProfile(env.DB, actor.id), winner.answers);
  const snapshot = await loadSubmittedApplication(env.DB, actor.id);
  assert.deepEqual(snapshot?.answers, winner.answers);
  const retry = await saveProfile(
    env.DB,
    actor.id,
    {
      ...answers,
      preferredName: "Must not overwrite",
      codeOfConductAccepted: true,
    },
    options,
  );
  assert.equal(retry.alreadySubmitted, true);
  assert.deepEqual(await loadProfile(env.DB, actor.id), winner.answers);
  assert.equal(
    await env.DB.prepare("SELECT count(*) FROM audit_log").first("count(*)"),
    2,
  );
});

test("simultaneous same-field profile edits allow one winner and preserve the original submission", async () => {
  const actor = await draftActor();
  const baseline = completeAnswers();
  await saveProfile(env.DB, actor.id, {
    ...baseline,
    codeOfConductAccepted: true,
  });
  const original = await loadSubmittedApplication(env.DB, actor.id);
  const results = await Promise.allSettled(
    ["One", "Two"].map((preferredName) =>
      saveProfile(
        env.DB,
        actor.id,
        { ...baseline, preferredName },
        { actor, baseline, intent: "edit" },
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" && statusError(409)(rejected.reason),
  );
  assert.deepEqual(await loadSubmittedApplication(env.DB, actor.id), original);
  assert.equal(
    await env.DB.prepare("SELECT count(*) FROM audit_log").first("count(*)"),
    2,
  );
});

test("submission checks draft revisions/generations, races autosave safely, and revoked sessions cannot submit", async () => {
  const actor = await draftActor();
  const answers = completeAnswers();
  const {
    heardAboutUs: _referral,
    certification: _certification,
    ...draftAnswers
  } = answers;
  const draft = await saveApplicationDraft(env.DB, actor, {
    ...draftInput(actor),
    answers: draftAnswers,
  });
  const input = { ...answers, codeOfConductAccepted: true };
  const options = {
    actor,
    intent: "submit" as const,
    draft: { revision: draft.revision, generation: null },
  };
  const race = await Promise.allSettled([
    saveProfile(env.DB, actor.id, input, options),
    saveApplicationDraft(env.DB, actor, {
      ...draftInput(actor, draft.revision),
      baseline: draft.answers,
      answers: { ...draft.answers, pronouns: "late edit" },
    }),
  ]);
  if (race[0].status === "fulfilled") {
    assert.equal(await loadApplicationDraft(env.DB, actor.id), null);
    assert.equal(await hasApplied(env.DB, actor.id), true);
  } else {
    assert.ok(statusError(409)(race[0].reason));
    assert.equal(await hasApplied(env.DB, actor.id), false);
    assert.equal(
      (await loadApplicationDraft(env.DB, actor.id))?.answers.pronouns,
      "late edit",
    );
  }
  const discarded = await draftActor("discarded");
  const old = await saveApplicationDraft(
    env.DB,
    discarded,
    draftInput(discarded),
  );
  const discardId = crypto.randomUUID();
  await discardApplicationDraft(env.DB, discarded, {
    userId: discarded.id,
    generation: null,
    discardId,
  });
  await assert.rejects(
    saveApplicationDraft(env.DB, discarded, {
      ...draftInput(discarded, old.revision),
      baseline: old.answers,
    }),
    statusError(409),
  );
  await assert.rejects(
    saveProfile(env.DB, discarded.id, input, {
      actor: discarded,
      intent: "submit",
      draft: { revision: old.revision, generation: null },
    }),
    statusError(409),
  );
  assert.deepEqual(await loadApplicationDraftState(env.DB, discarded.id), {
    draft: null,
    generation: discardId,
  });
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(discarded.sessionId)
    .run();
  await assert.rejects(
    saveProfile(env.DB, discarded.id, input, {
      actor: discarded,
      intent: "submit",
      draft: { revision: null, generation: discardId },
    }),
    statusError(401),
  );
  assert.equal(await hasApplied(env.DB, discarded.id), false);
});

test("durable first-submission intent failures roll back answers and side effects", async () => {
  const actor = await draftActor();
  await assert.rejects(
    saveProfile(
      env.DB,
      actor.id,
      { ...completeAnswers(), codeOfConductAccepted: true },
      {
        actor,
        intent: "submit",
        firstSubmissionStatements: () => [
          env.DB.prepare("INSERT INTO table_that_does_not_exist VALUES (1)"),
        ],
      },
    ),
  );
  assert.equal(await hasApplied(env.DB, actor.id), false);
  assert.equal(
    await env.DB.prepare("SELECT count(*) FROM audit_log").first("count(*)"),
    0,
  );
});

test("application progress uses milestone dates, not patrol approval or unrelated updates", async () => {
  const actor = await draftActor();
  assert.deepEqual(await loadApplicationProgress(env.DB, actor.id), {
    submittedAt: null,
    naloxoneCompletedAt: null,
    applicationApproved: false,
    applicationApprovedAt: null,
  });
  await saveProfile(env.DB, actor.id, {
    ...completeAnswers(),
    codeOfConductAccepted: true,
  });
  const submission = await loadSubmittedApplication(env.DB, actor.id);
  assert.ok(submission);
  const confirmedAt = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?").bind(
      actor.id,
    ),
    env.DB.prepare(
      "UPDATE profile SET naloxone_completed_at=? WHERE user_id=?",
    ).bind(confirmedAt, actor.id),
    env.DB.prepare(
      `UPDATE volunteer_status SET registration_approved=1, patrol_approved=1,
        approved_by=?, approved_at=1234, updated_at=5678 WHERE user_id=?`,
    ).bind(actor.id, actor.id),
  ]);
  const undated = await loadApplicationProgress(env.DB, actor.id);
  assert.equal(undated.submittedAt, Date.parse(submission.submittedAt));
  assert.equal(undated.naloxoneCompletedAt, confirmedAt);
  assert.equal(undated.applicationApproved, true);
  assert.equal(undated.applicationApprovedAt, null);
  assert.equal(isApplicationComplete(undated), true);
  assert.equal(
    isApplicationComplete({ ...undated, applicationApproved: false }),
    false,
  );
  await env.DB.prepare(
    `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
      VALUES ('application-approval', ?, ?, 'approval_changed', '["applicationApproved"]', 2000),
        ('patrol-approval', ?, ?, 'approval_changed', '["patrolApproved"]', 3000)`,
  )
    .bind(actor.id, actor.id, actor.id, actor.id)
    .run();
  const dated = await loadApplicationProgress(env.DB, actor.id);
  assert.equal(dated.applicationApprovedAt, 2000);
  assert.equal(isApplicationComplete(dated), true);
  assert.equal(isApplicationComplete({ ...dated, submittedAt: null }), false);
  assert.equal(
    isApplicationComplete({ ...dated, naloxoneCompletedAt: null }),
    false,
  );
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  const revoked = await loadApplicationProgress(env.DB, actor.id);
  assert.equal(revoked.applicationApproved, false);
  assert.equal(revoked.applicationApprovedAt, null);
  assert.equal(isApplicationComplete(revoked), false);
  assert.equal(
    isApplicationComplete({ ...revoked, applicationApproved: true }),
    true,
  );
});

test("orientees only see orientation events and rosters; patrol approval and organizers retain full access", async () => {
  const organizer = await draftActor("visibility-organizer");
  const actor = {
    ...(await draftActor("visibility-volunteer")),
    applicationSubmitted: true,
    applicationApproved: true,
    active: true,
    patrolApproved: true,
  };
  await saveProfile(env.DB, actor.id, {
    ...completeAnswers(),
    codeOfConductAccepted: true,
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?").bind(
      organizer.id,
    ),
    env.DB.prepare(
      "UPDATE volunteer_status SET registration_approved=1, patrol_approved=1, approved_by=?, approved_at=0 WHERE user_id=?",
    ).bind(organizer.id, actor.id),
  ]);
  const fixtures = [
    ["legacy-orientation", "orientation", null],
    ["included-orientation", "patrol", 1],
    ["excluded-orientation", "orientation", 0],
    ["regular-patrol", "patrol", 0],
  ] as const;
  const ids = fixtures.map(([id]) => id);
  await env.DB.batch(
    fixtures.map(([id, type, includesOrientation]) =>
      env.DB.prepare(
        `INSERT INTO event (id, type, includes_orientation, starts_at, meeting_point, spots, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'Meeting point', 8, ?, 0, 0)`,
      ).bind(
        id,
        type,
        includesOrientation,
        Date.now() + 86_400_000,
        organizer.id,
      ),
    ),
  );
  for (const id of ids) await changeSignup(env.DB, actor, id, "join");
  assert.equal((await listEvents(env.DB, actor)).length, 4);
  assert.equal((await listPublicRosters(env.DB, actor, ids)).people.length, 4);

  await env.DB.prepare(
    "UPDATE volunteer_status SET patrol_approved=0 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  const incompleteOrientee = { ...actor, patrolApproved: false };
  assert.deepEqual(await listEvents(env.DB, incompleteOrientee), []);
  await assert.rejects(
    changeSignup(env.DB, incompleteOrientee, "included-orientation", "join"),
    statusError(403),
  );
  await env.DB.prepare(
    "UPDATE profile SET naloxone_completed_at=0 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  const orientee = {
    ...incompleteOrientee,
    applicationComplete: isApplicationComplete(
      await loadApplicationProgress(env.DB, actor.id),
    ),
  };
  const expected = ["included-orientation", "legacy-orientation"];
  for (const view of ["volunteer", "manage"] as const) {
    const events = await listEvents(env.DB, orientee, "regular-patrol", view);
    assert.deepEqual(events.map((row) => row.id).sort(), expected);
  }
  // Supplying known IDs (or having an existing booking) must not bypass visibility.
  assert.deepEqual(
    (await listPublicRosters(env.DB, orientee, ids)).people
      .map((row) => row.eventId)
      .sort(),
    expected,
  );
  await changeSignup(env.DB, orientee, "regular-patrol", "cancel");
  await assert.rejects(
    changeSignup(env.DB, orientee, "regular-patrol", "join"),
    statusError(403),
  );
  await env.DB.prepare(
    "INSERT INTO orientation_completion VALUES ('visibility-completion', ?, 'legacy-orientation', ?, 0)",
  )
    .bind(actor.id, organizer.id)
    .run();
  assert.deepEqual(
    (await listEvents(env.DB, orientee)).map((row) => row.id).sort(),
    expected,
  );
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?").bind(
      actor.id,
    ),
    env.DB.prepare(
      "UPDATE volunteer_status SET registration_approved=0 WHERE user_id=?",
    ).bind(actor.id),
  ]);
  const manager = {
    ...orientee,
    role: "organizer" as const,
    applicationApproved: false,
  };
  for (const view of ["volunteer", "manage"] as const)
    assert.equal(
      (await listEvents(env.DB, manager, undefined, view)).length,
      4,
    );
  assert.equal(
    (await listPublicRosters(env.DB, manager, ids)).people.length,
    3,
  );
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
        VALUES (?, 'orientation', ?, 'Meeting point', 4, ?, 0, 0)`,
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
        VALUES (?, 'orientation', ?, 'Meeting point', 4, ?, 0, 0)`,
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
  await saveProfile(
    env.DB,
    actor.id,
    {
      ...answers,
      preferredName: "Changed nickname",
      phone: "604-555-0199",
      emergencyName: "Changed contact",
      medicalConditions: "Changed safety answer",
      teams: ["outreach", "non-patrol"],
      training: ["naloxone-administration"],
    },
    { baseline: answers },
  );
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
    VALUES ('protected-event', 'orientation', 0, 'Meeting point', 4, ?, 0, 0)`,
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
