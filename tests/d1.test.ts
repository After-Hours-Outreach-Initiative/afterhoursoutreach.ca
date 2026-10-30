import assert from "node:assert/strict";
import { test } from "vitest";
import { env } from "cloudflare:workers";
import { localEventFixtures } from "../scripts/local-event-fixtures";
import { localAccountFixtures } from "../scripts/local-account-fixtures";
import { personDisplayName } from "../src/data/person-name";
import { applicationDisplayName } from "../src/data/application";
import { personDisplayNameSql } from "../src/server/db/sql";
import { createDatabase } from "../src/server/db";
import { event } from "../src/server/db/schema";
import {
  changeSignup,
  listEvents,
  listPublicRosters,
  listRosters,
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
  listApplications,
  setVolunteerStatus,
  rejectApplication,
  viewVolunteerProfile,
  volunteerPageSize,
  approveForPatrols,
  findVolunteerOrientation,
  findCompletedVolunteerOrientation,
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
import { completeLocalApplicationStep } from "../src/dev/server/application-steps";
import { resetAccountState } from "../src/dev/server/account-states";
import { listLocalAccounts } from "../src/dev/server/account-list";
import {
  manualAccountPresets,
  localAccountUserId,
  developmentPresetStatus,
  developmentAccountStatus,
} from "../src/dev/accounts";

test("JS and SQL share preferred first name plus Unicode last initial formatting without changing answers", async () => {
  for (const [firstName, lastName, preferredName, legacyName, expected] of [
    ["Alexandra", "Montgomery", "Alex", "Stale Full Name", "Alex M."],
    ["Alexandra", "Montgomery", "", "Stale Full Name", "Alexandra M."],
    ["Mary", "Jones", "Mary  Jane", "Ignored", "Mary  Jane J."],
    ["Élodie", "\t李\u00a0", " \u2003", "Ignored", "Élodie 李."],
    ["Alex", "𠮷田", "Alex Montgomery", "Ignored", "Alex Montgomery 𠮷."],
    [null, null, "Multiword Preferred", "Ignored", "Multiword Preferred"],
    ["First", null, "", "Ignored Surname", "First"],
    [null, "Surname", null, "Ignored Name", "S."],
    [null, null, null, " Legacy\tMiddle\u00a0Surname ", "Legacy S."],
    [null, null, null, "OneName", "OneName"],
    [null, null, null, " ", ""],
  ]) {
    const names = { firstName, lastName, preferredName };
    assert.equal(personDisplayName(names, legacyName!), expected);
    if (firstName)
      assert.equal(
        applicationDisplayName({
          firstName,
          lastName: lastName ?? "",
          preferredName: preferredName ?? "",
          middleNames: "Marie",
        }),
        expected,
      );
    const sql = personDisplayNameSql({
      firstName: "input.firstName",
      lastName: "input.lastName",
      preferredName: "input.preferredName",
      legacyName: "input.legacyName",
    });
    assert.equal(
      await env.DB.prepare(
        `WITH input AS (
      SELECT ? AS firstName, ? AS lastName, ? AS preferredName, ? AS legacyName
    ) SELECT ${sql} AS name FROM input`,
      )
        .bind(firstName, lastName, preferredName, legacyName)
        .first("name"),
      expected,
    );
  }
});

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

test("development application shortcuts preserve snapshots and advance without emails or patrol approval", async () => {
  const actor = await draftActor();
  await assert.rejects(
    completeLocalApplicationStep(env.DB, actor, "naloxone"),
    statusError(409),
  );
  await completeLocalApplicationStep(env.DB, actor, "form");
  const original = await loadSubmittedApplication(env.DB, actor.id);
  assert.ok(original);
  await assert.rejects(
    completeLocalApplicationStep(env.DB, actor, "review"),
    statusError(409),
  );
  await completeLocalApplicationStep(env.DB, actor, "naloxone");
  // Discord connection is temporarily disabled.
  // await assert.rejects(
  //   completeLocalApplicationStep(env.DB, actor, "review"),
  //   statusError(409),
  // );
  // await completeLocalApplicationStep(env.DB, actor, "discord");
  await completeLocalApplicationStep(env.DB, actor, "review");
  const progress = await loadApplicationProgress(env.DB, actor.id);
  assert.ok(isApplicationComplete(progress));
  assert.ok(progress.applicationApprovedAt);
  const auditCount = await env.DB.prepare(
    "SELECT count(*) FROM audit_log",
  ).first("count(*)");
  assert.equal(progress.discordCompletedAt, null);
  for (const step of ["form", "naloxone", /* "discord", */ "review"] as const)
    await completeLocalApplicationStep(env.DB, actor, step);
  assert.deepEqual(await loadApplicationProgress(env.DB, actor.id), progress);
  assert.deepEqual(await loadSubmittedApplication(env.DB, actor.id), original);
  assert.equal(
    await env.DB.prepare("SELECT count(*) FROM audit_log").first("count(*)"),
    auditCount,
  );
  assert.deepEqual(
    await env.DB.prepare(
      `SELECT u.role, v.patrol_approved FROM user u
       JOIN volunteer_status v ON v.user_id=u.id WHERE u.id=?`,
    )
      .bind(actor.id)
      .first(),
    { role: "volunteer", patrol_approved: 0 },
  );
  for (const table of [
    "event_notification",
    "application_submission_notification",
  ])
    assert.equal(
      await env.DB.prepare(`SELECT count(*) FROM ${table}`).first("count(*)"),
      0,
    );
});

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
    "new-volunteer-1",
    "new-volunteer-2",
    "new-volunteer-3",
    "medic-1",
    "medic-2",
    "medic-3",
  ]) {
    const actor = {
      ...(await draftActor(id)),
      applicationSubmitted: true,
      applicationComplete: true,
      naloxoneCompleted: true,
      naloxoneCompletedAt: 0,
      active: true,
      applicationApproved: true,
      patrolApproved: !id.startsWith("new-volunteer"),
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO profile (user_id,first_name,last_name,preferred_name,phone,birth_date,emergency_contact_name,
        emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,training_experience,registered_at,updated_at)
        VALUES (?, 'Alice', 'PrivateSurname', ' Ally ', 'PRIVATE PHONE','2000-01-01','PRIVATE CONTACT','555','Friend','Friend','Help',?,'PRIVATE CERT','None',0,0)`,
      ).bind(id, id.startsWith("medic") ? '["medic"]' : "[]"),
      env.DB.prepare(
        "INSERT INTO volunteer_status (user_id,registration_approved,patrol_approved,approved_by,approved_at,updated_at) VALUES (?,1,?,'organizer',0,0)",
      ).bind(id, Number(actor.patrolApproved)),
    ]);
    // Deliberately record attendance only for unapproved volunteers: neither
    // attendance nor its absence may determine these categories.
    if (id.startsWith("new-volunteer"))
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
    [target.confirmed, target.medicConfirmed, target.newVolunteerConfirmed],
    [5, 2, 2],
  );
  const registeredAt = Date.parse("2026-01-02T03:04:05.000Z");
  await env.DB.prepare(
    "UPDATE signup SET created_at=?, updated_at=? WHERE event_id='target' AND status='confirmed'",
  )
    .bind(registeredAt, registeredAt + 3_600_000)
    .run();
  const roster = await listPublicRosters(env.DB, people[0], [
    "target",
    "history",
    ...Array.from({ length: 98 }, (_, index) => `unlisted-${index}`),
  ]);
  assert.equal(roster.people.length, 5);
  assert.ok(
    roster.people.every(
      (row) =>
        row.name === "Ally P." &&
        Object.keys(row).sort().join() === "category,eventId,medicMark,name",
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
  await assert.rejects(
    listRosters(env.DB, people[0], ["target"]),
    statusError(403),
  );
  for (const [preferredName, expectedName] of [
    [" AJ ", "AJ P."],
    ["  ", "Alice P."],
    ["", "Alice P."],
    [" Ally ", "Ally P."],
  ]) {
    await env.DB.prepare("UPDATE profile SET preferred_name=?")
      .bind(preferredName)
      .run();
    const publicRoster = await listPublicRosters(env.DB, people[0], ["target"]);
    assert.ok(publicRoster.people.every(({ name }) => name === expectedName));
    assert.equal(
      publicRoster.version === roster.version,
      expectedName === "Ally P.",
    );
    const organizerRoster = await listRosters(env.DB, organizer, ["target"]);
    assert.equal(organizerRoster.length, 5);
    assert.ok(organizerRoster.every(({ name }) => name === expectedName));
    assert.ok(
      organizerRoster.every((row) => row.registeredAt === registeredAt),
    );
    assert.doesNotMatch(
      JSON.stringify(organizerRoster),
      /PrivateSurname|firstName|lastName|preferredName|legacyName/,
    );
  }
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
  const newVolunteer = people.find(
    (_actor, index) =>
      index >= 2 && index < 5 && reserved[index - 2].status === "fulfilled",
  )!;
  await changeSignup(env.DB, newVolunteer, "target", "cancel");
  await assert.rejects(
    changeSignup(env.DB, general, "target", "join"),
    statusError(409),
  );
  await changeSignup(env.DB, newVolunteer, "target", "join");
});

test("manual approvals recolour existing signups consistently without inventing attendance", async () => {
  const actors: Actor[] = [];
  for (const id of ["organizer", "blue", "attended", "green", "red"]) {
    const actor: Actor = {
      ...(await draftActor(id)),
      role: id === "organizer" ? "organizer" : "volunteer",
      applicationSubmitted: true,
      applicationComplete: true,
      naloxoneCompleted: true,
      active: true,
      applicationApproved: true,
    };
    if (id === "organizer")
      await env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
        .bind(id)
        .run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO profile (user_id,first_name,last_name,preferred_name,phone,birth_date,
        emergency_contact_name,emergency_contact_phone,emergency_contact_relationship,heard_about_us,
        motivation,teams,medical_certification,training_experience,registered_at,naloxone_completed_at,updated_at)
        VALUES (?,?,'Volunteer',?,'555','2000-01-01','Contact','555','Friend','Friend','Help',?,'None','None',0,0,0)`,
      ).bind(id, id, id, id === "red" ? '["medic"]' : '["outreach"]'),
      env.DB.prepare(
        "INSERT INTO volunteer_status (user_id,registration_approved,updated_at) VALUES (?,1,0)",
      ).bind(id),
    ]);
    actors.push(actor);
  }
  const [organizer, ...volunteers] = actors;
  for (const id of ["history", "november-patrol", "other-orientation"])
    await env.DB.prepare(
      `INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
      VALUES (?,'orientation',?,'Meeting point',8,'organizer',0,0)`,
    )
      .bind(id, id === "history" ? 0 : Date.now() + 86_400_000)
      .run();
  for (const actor of volunteers)
    await changeSignup(env.DB, actor, "november-patrol", "join");
  const before = await listPublicRosters(env.DB, organizer, [
    "november-patrol",
  ]);
  assert.deepEqual(
    before.people.map(({ category }) => category),
    Array(4).fill("new-volunteer"),
  );

  await env.DB.prepare(
    "INSERT INTO orientation_completion VALUES ('attendance','attended','history','organizer',0)",
  ).run();
  assert.deepEqual(
    await listPublicRosters(env.DB, organizer, ["november-patrol"]),
    before,
  );
  const attendedEvents = await listEvents(env.DB, volunteers[1]);
  assert.equal(
    attendedEvents.find(({ id }) => id === "other-orientation")
      ?.orientationSignupBlocked,
    1,
  );
  await assert.rejects(
    changeSignup(env.DB, volunteers[1], "other-orientation", "join"),
    statusError(409),
  );

  for (const userId of ["green", "red"])
    await approveForPatrols(env.DB, organizer, { userId, version: 0 });
  const target = (await listEvents(env.DB, organizer)).find(
    ({ id }) => id === "november-patrol",
  )!;
  assert.deepEqual(
    [target.confirmed, target.newVolunteerConfirmed, target.medicConfirmed],
    [4, 2, 1],
  );
  const publicRoster = await listPublicRosters(env.DB, organizer, [target.id]);
  assert.notEqual(publicRoster.version, before.version);
  const expected = {
    blue: "new-volunteer",
    attended: "new-volunteer",
    green: "outreach-volunteer",
    red: "medic",
  };
  const roster = await listRosters(env.DB, organizer, [target.id]);
  assert.deepEqual(
    Object.fromEntries(
      roster.map(({ userId, category }) => [userId, category]),
    ),
    expected,
  );
  const listed = (await listVolunteers(env.DB, organizer)).rows.filter(
    ({ id }) => id !== organizer.id,
  );
  assert.deepEqual(
    Object.fromEntries(listed.map(({ id, category }) => [id, category])),
    expected,
  );
  assert.deepEqual(
    publicRoster.people.map(({ category }) => category).sort(),
    Object.values(expected).sort(),
  );
  assert.equal(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM orientation_completion WHERE user_id IN ('green','red')",
    ).first("n"),
    0,
  );

  await env.DB.prepare("DELETE FROM orientation_completion").run();
  assert.deepEqual(
    await listPublicRosters(env.DB, organizer, [target.id]),
    publicRoster,
  );
  const red = { ...volunteers[3], patrolApproved: true };
  assert.equal(
    (await listEvents(env.DB, red)).find(({ id }) => id === "other-orientation")
      ?.medicEligible,
    1,
  );
  await changeSignup(env.DB, red, "other-orientation", "join");
  await env.DB.prepare(
    "UPDATE profile SET teams='[\"outreach\"]' WHERE user_id='red'",
  ).run();
  assert.equal(
    (await listRosters(env.DB, organizer, [target.id])).find(
      ({ userId }) => userId === "red",
    )?.category,
    "outreach-volunteer",
  );
  assert.notEqual(
    (await listPublicRosters(env.DB, organizer, [target.id])).version,
    publicRoster.version,
  );
});

test("new medic marks require application approval and team selection without satisfying medic reservations", async () => {
  const actors = new Map<string, Actor>();
  for (const [id, approved, patrol, teams] of [
    ["organizer", true, false, ["outreach"]],
    ["new-medic", true, false, ["medic"]],
    ["new-outreach", true, false, ["outreach"]],
    ["outreach", true, true, ["outreach"]],
    ["eligible-medic", true, true, ["medic"]],
    ["pending-medic", false, false, ["medic"]],
    ["pending-outreach", false, false, ["outreach"]],
  ] as const) {
    const actor: Actor = {
      ...(await draftActor(id)),
      role: id === "organizer" ? "organizer" : "volunteer",
      applicationSubmitted: true,
      applicationComplete: true,
      naloxoneCompleted: true,
      active: true,
      applicationApproved: approved,
      patrolApproved: patrol,
    };
    if (id === "organizer")
      await env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
        .bind(id)
        .run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO profile (user_id,first_name,last_name,preferred_name,phone,birth_date,
        emergency_contact_name,emergency_contact_phone,emergency_contact_relationship,heard_about_us,
        motivation,teams,medical_certification,training_experience,registered_at,naloxone_completed_at,updated_at)
        VALUES (?,?,'Volunteer','','555','2000-01-01','Contact','555','Friend','Friend','Help',?,'None','None',0,0,0)`,
      ).bind(id, id, JSON.stringify(teams)),
      env.DB.prepare(
        `INSERT INTO volunteer_status
        (user_id,registration_approved,patrol_approved,approved_by,approved_at,updated_at)
        VALUES (?,?,?,'organizer',0,0)`,
      ).bind(id, Number(approved), Number(patrol)),
    ]);
    actors.set(id, actor);
  }
  const organizer = actors.get("organizer")!;
  const newMedic = actors.get("new-medic")!;
  const outreach = actors.get("outreach")!;
  await env.DB.prepare(
    `INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
    VALUES ('reserved','orientation',?,'Meeting point',4,'organizer',0,0)`,
  )
    .bind(Date.now() + 86_400_000)
    .run();
  await changeSignup(env.DB, newMedic, "reserved", "join");
  await changeSignup(env.DB, actors.get("new-outreach")!, "reserved", "join");

  const registrations = await listRosters(env.DB, organizer, ["reserved"]);
  assert.deepEqual(
    registrations.map(({ userId, category, medicMark, patrolApproved }) => ({
      userId,
      category,
      medicMark,
      patrolApproved,
    })),
    [
      {
        userId: "new-medic",
        category: "new-volunteer",
        medicMark: 1,
        patrolApproved: 0,
      },
      {
        userId: "new-outreach",
        category: "new-volunteer",
        medicMark: 0,
        patrolApproved: 0,
      },
    ],
  );
  const before = await listPublicRosters(env.DB, organizer, ["reserved"]);
  assert.equal(
    before.people.find(({ name }) => name === "new-medic V.")?.medicMark,
    1,
  );
  const directory = (await listVolunteers(env.DB, organizer)).rows;
  assert.equal(directory.find(({ id }) => id === "new-medic")?.medicMark, 1);
  assert.equal(
    directory.find(({ id }) => id === "eligible-medic")?.medicMark,
    1,
  );
  assert.equal(
    directory.find(({ id }) => id === "pending-medic"),
    undefined,
  );
  assert.equal(directory.find(({ id }) => id === "outreach")?.medicMark, 0);
  // Application presentation shows selected teams before approval, even while
  // the avatar category is new-volunteer; it does not change roster eligibility.
  assert.deepEqual(
    (await listApplications(env.DB, organizer)).rows.map(
      ({ id, category, medicMark }) => ({ id, category, medicMark }),
    ),
    [
      { id: "pending-medic", category: "new-volunteer", medicMark: 1 },
      { id: "pending-outreach", category: "new-volunteer", medicMark: 0 },
    ],
  );

  const selected = (await listEvents(env.DB, newMedic)).find(
    ({ id }) => id === "reserved",
  )!;
  assert.deepEqual(
    [
      selected.confirmed,
      selected.newVolunteerConfirmed,
      selected.medicConfirmed,
      selected.medicEligible,
    ],
    [2, 2, 0, 0],
  );
  assert.equal(
    (await listEvents(env.DB, outreach)).find(({ id }) => id === "reserved")
      ?.availableSpots,
    0,
  );
  await assert.rejects(
    changeSignup(env.DB, outreach, "reserved", "join"),
    statusError(409),
  );

  // A display-only team edit must refresh polling without changing capacity.
  await env.DB.prepare(
    "UPDATE profile SET teams='[\"outreach\"]' WHERE user_id='new-medic'",
  ).run();
  const unmarked = await listPublicRosters(env.DB, organizer, ["reserved"]);
  assert.notEqual(unmarked.version, before.version);
  assert.equal(
    unmarked.people.find(({ name }) => name === "new-medic V.")?.category,
    "new-volunteer",
  );
  assert.equal(
    unmarked.people.find(({ name }) => name === "new-medic V.")?.medicMark,
    0,
  );
  await env.DB.prepare(
    "UPDATE profile SET teams='[\"medic\"]' WHERE user_id='new-medic'",
  ).run();
  assert.equal(
    (await listPublicRosters(env.DB, organizer, ["reserved"])).version,
    before.version,
  );

  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1 WHERE user_id='pending-medic'",
  ).run();
  assert.equal(
    (await listVolunteers(env.DB, organizer)).rows.find(
      ({ id }) => id === "pending-medic",
    )?.medicMark,
    1,
  );
  await changeSignup(env.DB, actors.get("eligible-medic")!, "reserved", "join");
  const after = (await listEvents(env.DB, newMedic)).find(
    ({ id }) => id === "reserved",
  )!;
  assert.deepEqual(
    [
      after.confirmed,
      after.newVolunteerConfirmed,
      after.medicConfirmed,
      after.medicEligible,
    ],
    [3, 2, 1, 0],
  );
  assert.equal(
    (await listPublicRosters(env.DB, organizer, ["reserved"])).people.filter(
      ({ medicMark }) => medicMark,
    ).length,
    2,
  );
  await assert.rejects(
    changeSignup(env.DB, outreach, "reserved", "join"),
    statusError(409),
  );
});

const draftInput = (actor: Actor, revision: string | null = null) => ({
  version: 1,
  userId: actor.id,
  revision,
  answers: { firstName: "  Draft name ", birthDate: "2020-01-01" },
});
const statusError = (status: number) => (error: unknown) =>
  error instanceof RequestError && error.status === status;

test("volunteer directory sorts names, displayed roles and patrol flags before applying offsets", async () => {
  const actor: Actor = {
    ...(await draftActor("organizer")),
    role: "organizer",
    applicationSubmitted: true,
    active: true,
    applicationApproved: true,
  };
  for (const [id, name, role, patrol, teams] of [
    ["organizer", "bravo", "organizer", 0, "[]"],
    ["medic", "zebra", "volunteer", 1, '["medic"]'],
    ["new", "Zulu", "volunteer", 0, "[]"],
    ["outreach", "Alpha", "volunteer", 1, "[]"],
    ["tie", "alpha", "volunteer", 0, "[]"],
  ] as const) {
    if (id !== actor.id) await draftActor(id);
    await env.DB.batch([
      env.DB.prepare("UPDATE user SET role=? WHERE id=?").bind(role, id),
      env.DB.prepare(
        `INSERT INTO profile (
          user_id, preferred_name, phone, birth_date, emergency_contact_name,
          emergency_contact_phone, emergency_contact_relationship, heard_about_us,
          motivation, teams, medical_certification, training_experience, registered_at, updated_at
        ) VALUES (?, ?, '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', ?, 'None', 'None', 0, 0)`,
      ).bind(id, name, teams),
      env.DB.prepare(
        "INSERT INTO volunteer_status (user_id, active, registration_approved, patrol_approved, approved_by, approved_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, 0)",
      ).bind(id, patrol, patrol ? actor.id : null, patrol ? 0 : null),
    ]);
  }
  for (const [sort, direction, expected] of [
    ["name", "asc", ["outreach", "tie", "organizer", "medic", "new"]],
    ["name", "desc", ["new", "medic", "organizer", "outreach", "tie"]],
    ["role", "asc", ["outreach", "medic", "tie", "new", "organizer"]],
    ["role", "desc", ["organizer", "tie", "new", "medic", "outreach"]],
    ["patrol", "asc", ["tie", "organizer", "new", "outreach", "medic"]],
    ["patrol", "desc", ["outreach", "medic", "tie", "organizer", "new"]],
  ] as const) {
    const page = await listVolunteers(env.DB, actor, "", 1, sort, direction);
    assert.deepEqual(
      page.rows.map(({ id }) => id),
      expected.slice(1),
    );
    assert.equal(page.allApplicantsCount, 5);
  }
  assert.deepEqual(
    (await listVolunteers(env.DB, actor, "AL", 0, "role", "asc")).rows.map(
      ({ id }) => id,
    ),
    ["outreach", "tie"],
  );
});

test("review queue counts only review-ready applications matching search independently of pages and profile views", async () => {
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
        motivation, teams, medical_certification, training_experience, registered_at, naloxone_completed_at, updated_at
      ) VALUES (?, ?, '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', '[]', 'None', 'None', 0, 0, 0)`,
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
  const first = await listApplications(env.DB, actor, "", 0, "awaiting");
  assert.equal(first.awaitingApprovalCount, count);
  assert.equal(first.rows.length, volunteerPageSize);
  assert.equal(first.hasMore, true);
  assert.equal(first.rows[0].active, 0); // Inactive is not an approval state.
  assert.equal(first.rows[1].patrolApproved, 1); // Neither is patrol approval.
  const second = await listApplications(
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
  for (const [search, expected] of [
    ["pending-02", 1],
    ["no match", 0],
    ["approved", 0],
  ] as const)
    assert.equal(
      (await listApplications(env.DB, actor, search, 0, "awaiting"))
        .awaitingApprovalCount,
      expected,
    );
  assert.deepEqual(
    (await listApplications(env.DB, actor, "approved", 0, "awaiting")).rows,
    [],
  );
  assert.equal(
    (await listVolunteers(env.DB, actor, "approved")).rows[0].id,
    "approved",
  );
  assert.deepEqual(
    (await listVolunteers(env.DB, actor)).rows.map(({ id }) => id).sort(),
    ["approved", actor.id],
  );
  assert.equal(
    (await listApplications(env.DB, actor)).allApplicantsCount,
    count,
  );
  assert.equal(
    await env.DB.prepare("SELECT count(*) FROM audit_log").first("count(*)"),
    0,
  );
  // Sort the full mixed-progress result before slicing pages, using visible
  // labels and case-insensitive name/id ties even in descending order.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE profile SET naloxone_completed_at=NULL WHERE user_id='pending-52'",
    ),
    env.DB.prepare(
      "UPDATE volunteer_status SET application_rejection_reason='Review decision' WHERE user_id='pending-01'",
    ),
    env.DB.prepare(
      "UPDATE profile SET preferred_name='ALPHA' WHERE user_id='pending-02'",
    ),
    env.DB.prepare(
      "UPDATE profile SET preferred_name='alpha' WHERE user_id='pending-03'",
    ),
  ]);
  const pending = ids.filter((id) => id.startsWith("pending-"));
  const ties = ["pending-02", "pending-03"];
  const otherNames = pending.filter((id) => !ties.includes(id));
  const reviewNames = [
    ...ties,
    ...otherNames.filter((id) => !["pending-01", "pending-52"].includes(id)),
  ];
  for (const [sort, direction, expected] of [
    ["name", "asc", [...ties, ...otherNames]],
    ["name", "desc", [...otherNames.toReversed(), ...ties]],
    ["progress", "asc", ["pending-52", ...reviewNames, "pending-01"]],
    ["progress", "desc", ["pending-01", ...reviewNames, "pending-52"]],
  ] as const) {
    const pages = await Promise.all(
      [0, volunteerPageSize].map((offset) =>
        listApplications(env.DB, actor, "", offset, "all", sort, direction),
      ),
    );
    assert.deepEqual(
      pages.flatMap(({ rows }) => rows.map(({ id }) => id)),
      expected,
    );
    assert.deepEqual(
      pages.map(({ hasMore }) => hasMore),
      [true, false],
    );
    for (const page of pages) {
      assert.equal(page.allApplicantsCount, count);
      assert.equal(page.awaitingApprovalCount, count - 2);
    }
  }
  assert.deepEqual(
    (
      await listApplications(
        env.DB,
        actor,
        "ALPHA",
        0,
        "awaiting",
        "progress",
        "desc",
      )
    ).rows.map(({ id }) => id),
    ties,
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE profile SET naloxone_completed_at=0 WHERE user_id='pending-52'",
    ),
    env.DB.prepare(
      "UPDATE volunteer_status SET application_rejection_reason=NULL WHERE user_id='pending-01'",
    ),
    env.DB.prepare(
      "UPDATE profile SET preferred_name=user_id WHERE user_id IN ('pending-02', 'pending-03')",
    ),
  ]);
  const profile = await viewVolunteerProfile(env.DB, actor, "pending-02");
  assert.equal(profile?.email, "pending-02@example.org");
  assert.equal(profile?.answers.preferredName, "pending-02");
  assert.equal(profile?.submittedAt, "1970-01-01T00:00:00.000Z");
  // Legacy profiles have no recorded acknowledgement; never invent one.
  assert.equal(profile?.codeOfConductVersion, null);
  assert.equal(profile?.codeOfConductAcceptedAt, null);
  assert.equal(profile?.submission, null);
  assert.equal(
    (await listApplications(env.DB, actor, "pending-02", 0, "awaiting")).rows
      .length,
    1,
  );
  assert.equal(
    (await listApplications(env.DB, actor)).awaitingApprovalCount,
    count,
  );
  // A submitted form is still in progress until the earlier course step is complete.
  await env.DB.prepare(
    "UPDATE profile SET naloxone_completed_at=NULL WHERE user_id='pending-02'",
  ).run();
  const inProgress = await listApplications(env.DB, actor, "pending-02");
  assert.deepEqual(
    (await listVolunteers(env.DB, actor, "pending-02")).rows,
    [],
  );
  assert.equal(inProgress.rows[0].applicationReadyForReview, 0);
  assert.equal(inProgress.allApplicantsCount, 1);
  assert.equal(inProgress.awaitingApprovalCount, 0);
  assert.deepEqual(
    (await listApplications(env.DB, actor, "pending-02", 0, "awaiting")).rows,
    [],
  );
  assert.equal(
    (await listApplications(env.DB, actor)).awaitingApprovalCount,
    count - 1,
  );
  await env.DB.prepare(
    "UPDATE profile SET naloxone_completed_at=0 WHERE user_id='pending-02'",
  ).run();
  const ready = await listApplications(
    env.DB,
    actor,
    "pending-02",
    0,
    "awaiting",
  );
  assert.equal(ready.rows[0].applicationReadyForReview, 1);
  assert.equal(ready.awaitingApprovalCount, 1);
  assert.equal(
    await env.DB.prepare("SELECT action FROM audit_log").first("action"),
    "profile_viewed",
  );
  // This queue test models legacy submissions without newly required milestones.
  await env.DB.prepare(
    "DELETE FROM discord_requirement WHERE user_id='pending-02'",
  ).run();
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
  assert.ok(approvalEmails[0].text.includes(`approved by ${actor.name}!`));
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
      /currently inactive.*contact an organizer at info@afterhoursoutreach\.ca to restore access before registering/,
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
    assert.equal(email?.subject, "Your volunteer access changed");
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
  const after = await listApplications(
    env.DB,
    actor,
    "pending-02",
    0,
    "awaiting",
  );
  assert.deepEqual(after.rows, []);
  assert.equal(after.awaitingApprovalCount, 0);
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
    (await listApplications(env.DB, actor, "pending-02", 0, "awaiting"))
      .awaitingApprovalCount,
    1,
  );
  assert.deepEqual(
    (await listVolunteers(env.DB, actor, "pending-02")).rows,
    [],
  );
  for (const denied of [
    { ...actor, role: "volunteer" as const },
    { ...actor, active: false },
    { ...actor, applicationSubmitted: false },
    { ...actor, twoFactorEnabled: true, twoFactorVerified: false },
  ])
    await assert.rejects(
      listApplications(env.DB, denied, "", 0, "awaiting"),
      statusError(403),
    );
  // Organizer event access is a role exception, not application approval.
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  const organizerQueue = await listApplications(
    env.DB,
    { ...actor, applicationApproved: false },
    "queue-organizer",
    0,
    "awaiting",
  );
  assert.equal(organizerQueue.awaitingApprovalCount, 1);
  assert.equal(organizerQueue.rows[0].id, actor.id);
  const rejection = {
    userId: "pending-02",
    version: (await listApplications(env.DB, actor, "pending-02")).rows[0]
      .updatedAt,
    reason: "We cannot accommodate your availability.",
  };
  const decision = await rejectApplication(env.DB, actor, rejection);
  assert.equal(
    (await loadApplicationProgress(env.DB, rejection.userId))
      .applicationRejectionReason,
    rejection.reason,
  );
  assert.equal(
    (await listApplications(env.DB, actor, rejection.userId, 0, "awaiting"))
      .awaitingApprovalCount,
    0,
  );
  const localDelivery = await deliverNotifications(
    { ...env, APP_ENV: "local" },
    decision.operation,
    async () => {
      throw new Error("Local rejection must not call a provider");
    },
  );
  assert.equal(localDelivery.simulated, 1);
  const rejectionPayload = JSON.parse(
    (await env.DB.prepare(
      "SELECT payload FROM event_notification_batch WHERE operation_id=?",
    )
      .bind(decision.operation)
      .first<string>("payload"))!,
  );
  assert.ok(rejectionPayload[0].text.includes(rejection.reason));
  assert.deepEqual(rejectionPayload[0].to, ["pending-02@example.org"]);
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(actor.sessionId)
    .run();
  await assert.rejects(
    viewVolunteerProfile(env.DB, actor, "pending-02"),
    statusError(403),
  ); // A stale organizer actor cannot disclose email or application answers.
  await assert.rejects(
    rejectApplication(env.DB, actor, {
      ...rejection,
      userId: "pending-03",
      version: 0,
    }),
    statusError(409),
  );
  assert.equal(
    await env.DB.prepare(
      "SELECT application_rejection_reason FROM volunteer_status WHERE user_id='pending-03'",
    ).first("application_rejection_reason"),
    null,
  );
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

test("simultaneous profile name edits allow one winner and preserve the original submission", async () => {
  const actor = await draftActor();
  const baseline = completeAnswers();
  await saveProfile(env.DB, actor.id, {
    ...baseline,
    codeOfConductAccepted: true,
  });
  const original = await loadSubmittedApplication(env.DB, actor.id);
  const results = await Promise.allSettled(
    [{ firstName: "One" }, { lastName: "Two" }].map((name) =>
      saveProfile(
        env.DB,
        actor.id,
        { ...baseline, ...name },
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
  assert.deepEqual(rejected.reason.details.conflicts, [
    ["firstName", "middleNames", "lastName"],
  ]);
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

test("application progress and organizer attribution use application audits, not patrol approval or unrelated updates", async () => {
  const actor = await draftActor();
  assert.deepEqual(await loadApplicationProgress(env.DB, actor.id), {
    submittedAt: null,
    naloxoneCompletedAt: null,
    applicationApproved: false,
    applicationApprovedAt: null,
    applicationRejectionReason: null,
    discordRequired: true,
    discordCompletedAt: null,
  });
  await saveProfile(env.DB, actor.id, {
    ...completeAnswers(),
    codeOfConductAccepted: true,
  });
  const submission = await loadSubmittedApplication(env.DB, actor.id);
  assert.ok(submission);
  const confirmedAt = Date.now();
  // Model a grandfathered profile; new Discord milestones are covered separately.
  await env.DB.prepare("DELETE FROM discord_requirement WHERE user_id=?")
    .bind(actor.id)
    .run();
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
  const reviewer: Actor = {
    ...actor,
    role: "organizer",
    applicationSubmitted: true,
    active: true,
  };
  assert.equal(
    (await viewVolunteerProfile(env.DB, reviewer, actor.id))
      ?.applicationApprovedBy,
    null,
  ); // Never infer a legacy application approver from patrol approved_by.
  assert.equal(isApplicationComplete(undated), true);
  assert.equal(
    isApplicationComplete({ ...undated, applicationApproved: false }),
    false,
  );
  const approver = await draftActor("application-approver");
  await saveProfile(env.DB, approver.id, {
    ...completeAnswers(),
    firstName: "Alexandra",
    middleNames: "Marie",
    lastName: "Montgomery",
    preferredName: "Alex",
    codeOfConductAccepted: true,
  });
  await env.DB.prepare(
    "UPDATE user SET role='organizer',name='Application Organizer' WHERE id=?",
  )
    .bind(approver.id)
    .run();
  await env.DB.prepare(
    `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
      VALUES ('application-approval', ?, ?, 'approval_changed', '["registrationApproved"]', 2000),
        ('patrol-approval', ?, ?, 'approval_changed', '["patrolApproved"]', 3000)`,
  )
    .bind(approver.id, actor.id, actor.id, actor.id)
    .run();
  const dated = await loadApplicationProgress(env.DB, actor.id);
  assert.equal(dated.applicationApprovedAt, 2000);
  assert.deepEqual(
    (await viewVolunteerProfile(env.DB, reviewer, actor.id))
      ?.applicationApprovedBy,
    {
      id: approver.id,
      name: "Alex M.",
      email: "application-approver@example.org",
      approvedAt: 2000,
    },
  ); // A later, different patrol approver must not replace the application approver.
  assert.equal("applicationApprovedBy" in dated, false);
  assert.equal(
    "applicationApprovedBy" in (await loadProfile(env.DB, actor.id))!,
    false,
  );
  await assert.rejects(
    viewVolunteerProfile(
      env.DB,
      {
        ...reviewer,
        role: "volunteer",
        applicationApproved: true,
        applicationComplete: true,
      },
      actor.id,
    ),
    statusError(403),
  );
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
  assert.equal(
    (await viewVolunteerProfile(env.DB, reviewer, actor.id))
      ?.applicationApprovedBy,
    null,
  );
  assert.equal(isApplicationComplete(revoked), false);
  assert.equal(
    isApplicationComplete({ ...revoked, applicationApproved: true }),
    true,
  );
  await setVolunteerStatus(env.DB, reviewer, {
    userId: actor.id,
    version: 5678,
    active: true,
    applicationApproved: true,
    patrolApproved: true,
  });
  const reapproved = (await viewVolunteerProfile(env.DB, reviewer, actor.id))
    ?.applicationApprovedBy;
  assert.equal(reapproved?.id, reviewer.id);
  assert.equal(
    reapproved?.approvedAt,
    (await loadApplicationProgress(env.DB, actor.id)).applicationApprovedAt,
  ); // Reapproval uses the latest applicationApproved audit, not the old approver.
});

async function patrolApprovalFixture() {
  const organizer = {
    ...(await draftActor("patrol-organizer")),
    role: "organizer" as const,
    applicationSubmitted: true,
    active: true,
  };
  const volunteer = await draftActor("patrol-new-volunteer");
  for (const actor of [organizer, volunteer])
    await saveProfile(env.DB, actor.id, {
      ...completeAnswers(),
      codeOfConductAccepted: true,
    });
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?").bind(
      organizer.id,
    ),
    env.DB.prepare(
      "UPDATE volunteer_status SET registration_approved=1, active=1, updated_at=0",
    ),
    env.DB.prepare(
      `INSERT INTO event (id,type,includes_orientation,starts_at,meeting_point,spots,created_by,created_at,updated_at)
      VALUES ('patrol-orientation','patrol',1,?,'Orientation meeting point',8,?,0,0)`,
    ).bind(Date.now() + 86_400_000, organizer.id),
    env.DB.prepare(
      "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES ('patrol-orientation-signup','patrol-orientation',?,0,0)",
    ).bind(volunteer.id),
  ]);
  await env.DB.prepare("DELETE FROM audit_log").run();
  return { organizer, volunteer, input: { userId: volunteer.id, version: 0 } };
}

test("one patrol approval records orientation, approval, attribution and optional email atomically", async () => {
  const { organizer, volunteer, input } = await patrolApprovalFixture();
  const attendanceInput = { ...input, eventId: "patrol-orientation" };
  assert.equal(
    (await findVolunteerOrientation(env.DB, organizer, volunteer.id))?.eventId,
    "patrol-orientation",
  );
  await assert.rejects(
    approveForPatrols(env.DB, organizer, attendanceInput),
    statusError(409),
  );
  assert.equal(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM orientation_completion",
    ).first("n"),
    0,
  );
  await env.DB.prepare(
    "UPDATE event SET starts_at=0 WHERE id='patrol-orientation'",
  ).run();
  await env.DB.prepare("UPDATE volunteer_status SET active=0 WHERE user_id=?")
    .bind(volunteer.id)
    .run();
  const attempts = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      approveForPatrols(env.DB, organizer, {
        ...attendanceInput,
        notify: true,
      }),
    ),
  );
  const winner = attempts.find((attempt) => attempt.status === "fulfilled");
  assert.ok(winner?.status === "fulfilled");
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1,
  );
  const result = winner.value;
  assert.equal(
    await env.DB.prepare("SELECT active FROM volunteer_status WHERE user_id=?")
      .bind(volunteer.id)
      .first("active"),
    0,
  );
  const approval = await env.DB.prepare(
    "SELECT patrol_approved, approved_by, approved_at, updated_at FROM volunteer_status WHERE user_id=?",
  )
    .bind(volunteer.id)
    .first();
  const completion = await env.DB.prepare(
    "SELECT event_id, marked_by, marked_at FROM orientation_completion WHERE user_id=?",
  )
    .bind(volunteer.id)
    .first();
  assert.equal(approval?.patrol_approved, 1);
  assert.equal(approval?.approved_by, organizer.id);
  assert.equal(completion?.event_id, "patrol-orientation");
  assert.equal(completion?.marked_by, organizer.id);
  assert.equal(completion?.marked_at, approval?.approved_at);
  assert.deepEqual(
    await findCompletedVolunteerOrientation(env.DB, organizer, volunteer.id),
    {
      eventId: "patrol-orientation",
      startsAt: 0,
      meetingPoint: "Orientation meeting point",
    },
  );
  assert.equal(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE action IN ('approval_changed','orientation_completed')",
    ).first("n"),
    2,
  );
  assert.equal(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM event_notification WHERE operation_id=?",
    )
      .bind(result.operation)
      .first("n"),
    1,
  );
  await assert.rejects(
    approveForPatrols(env.DB, organizer, input),
    statusError(409),
  );
  // Reapproval keeps recorded attendance, even if its original registration is gone.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE volunteer_status SET patrol_approved=0, approved_by=NULL, approved_at=NULL WHERE user_id=?",
    ).bind(volunteer.id),
    env.DB.prepare("UPDATE signup SET status='cancelled' WHERE user_id=?").bind(
      volunteer.id,
    ),
  ]);
  assert.equal(
    await findVolunteerOrientation(env.DB, organizer, volunteer.id),
    null,
  );
  assert.equal(
    (await findCompletedVolunteerOrientation(env.DB, organizer, volunteer.id))
      ?.eventId,
    "patrol-orientation",
  );
  await approveForPatrols(env.DB, organizer, {
    ...input,
    version: Number(approval!.updated_at),
  });
  assert.deepEqual(
    await env.DB.prepare(
      "SELECT event_id, marked_by, marked_at FROM orientation_completion WHERE user_id=?",
    )
      .bind(volunteer.id)
      .first(),
    completion,
  );
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM event_notification").first(
      "n",
    ),
    1,
  );
});

test("merged patrol approval rejects invalid attendance, unapproved applicants and revoked organizer sessions without partial writes", async () => {
  const { organizer, volunteer, input } = await patrolApprovalFixture();
  await env.DB.prepare(
    "UPDATE event SET starts_at=0 WHERE id='patrol-orientation'",
  ).run();
  for (const [invalidate, restore] of [
    ["UPDATE event SET cancelled_at=1", "UPDATE event SET cancelled_at=NULL"],
    [
      "UPDATE signup SET status='cancelled'",
      "UPDATE signup SET status='confirmed'",
    ],
    [
      "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='patrol-new-volunteer'",
      "UPDATE volunteer_status SET registration_approved=1 WHERE user_id='patrol-new-volunteer'",
    ],
    [
      "UPDATE session SET expires_at=0 WHERE user_id='patrol-organizer'",
      `UPDATE session SET expires_at=${Date.now() + 3_600_000} WHERE user_id='patrol-organizer'`,
    ],
  ]) {
    await env.DB.prepare(invalidate).run();
    if (
      invalidate.includes("registration_approved") ||
      invalidate.includes("expires_at")
    )
      await assert.rejects(
        approveForPatrols(env.DB, organizer, input),
        statusError(409),
      );
    await assert.rejects(
      approveForPatrols(env.DB, organizer, {
        ...input,
        eventId: "patrol-orientation",
        notify: true,
      }),
      statusError(409),
    );
    // A past signup cannot be recreated through normal signup controls.
    if (restore.includes("UPDATE signup"))
      await env.DB.prepare("UPDATE event SET starts_at=?")
        .bind(Date.now() + 86_400_000)
        .run();
    await env.DB.prepare(restore).run();
    await env.DB.prepare("UPDATE event SET starts_at=0").run();
  }
  assert.equal(
    await env.DB.prepare(
      "SELECT patrol_approved FROM volunteer_status WHERE user_id=?",
    )
      .bind(volunteer.id)
      .first("patrol_approved"),
    0,
  );
  for (const table of [
    "orientation_completion",
    "audit_log",
    "event_notification",
  ])
    assert.equal(
      await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"),
      0,
    );
  await assert.rejects(
    approveForPatrols(env.DB, organizer, {
      ...input,
      eventId: "not-the-registered-event",
    }),
    statusError(409),
  );
});

test("a failure during combined approval rolls back patrol access and orientation together", async () => {
  const { organizer, volunteer, input } = await patrolApprovalFixture();
  await env.DB.prepare("UPDATE event SET starts_at=0").run();
  await env.DB.prepare(
    `CREATE TRIGGER reject_orientation BEFORE INSERT ON orientation_completion BEGIN SELECT RAISE(ABORT, 'test_orientation_failure'); END`,
  ).run();
  await assert.rejects(
    approveForPatrols(env.DB, organizer, {
      ...input,
      eventId: "patrol-orientation",
      notify: true,
    }),
  );
  assert.equal(
    await env.DB.prepare(
      "SELECT patrol_approved FROM volunteer_status WHERE user_id=?",
    )
      .bind(volunteer.id)
      .first("patrol_approved"),
    0,
  );
  for (const table of [
    "orientation_completion",
    "audit_log",
    "event_notification",
  ])
    assert.equal(
      await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"),
      0,
    );
});

test.each(["unbooked", "booked", "started"] as const)(
  "patrol approval supports the %s orientation state without inferring attendance",
  async (state) => {
    const { organizer, volunteer, input } = await patrolApprovalFixture();
    if (state === "unbooked")
      await env.DB.prepare(
        "UPDATE signup SET status='cancelled' WHERE user_id=?",
      )
        .bind(volunteer.id)
        .run();
    if (state === "started")
      await env.DB.prepare(
        "UPDATE event SET starts_at=0 WHERE id='patrol-orientation'",
      ).run();
    await approveForPatrols(env.DB, organizer, { ...input, notify: true });
    const saved = await env.DB.prepare(
      "SELECT patrol_approved, approved_by, updated_at FROM volunteer_status WHERE user_id=?",
    )
      .bind(volunteer.id)
      .first();
    assert.equal(saved?.patrol_approved, 1);
    assert.equal(saved?.approved_by, organizer.id);
    assert.equal(
      await findCompletedVolunteerOrientation(env.DB, organizer, volunteer.id),
      null,
    );
    assert.equal(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM orientation_completion",
      ).first("n"),
      0,
    );
    assert.equal(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE action='orientation_completed'",
      ).first("n"),
      0,
    );
    assert.equal(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM event_notification",
      ).first("n"),
      1,
    );
    await assert.rejects(
      approveForPatrols(env.DB, organizer, input),
      statusError(409),
    );
    await env.DB.prepare("UPDATE session SET expires_at=0 WHERE user_id=?")
      .bind(organizer.id)
      .run();
    await assert.rejects(
      approveForPatrols(env.DB, organizer, {
        ...input,
        version: Number(saved!.updated_at),
      }),
      statusError(409),
    );
  },
);

test("new volunteers only see orientation events and rosters; patrol approval and organizers retain full access", async () => {
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
  const incompleteNewVolunteer = { ...actor, patrolApproved: false };
  assert.deepEqual(await listEvents(env.DB, incompleteNewVolunteer), []);
  await assert.rejects(
    changeSignup(
      env.DB,
      incompleteNewVolunteer,
      "included-orientation",
      "join",
    ),
    statusError(403),
  );
  await env.DB.prepare(
    "UPDATE profile SET naloxone_completed_at=0 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  await completeLocalApplicationStep(env.DB, actor, "discord");
  const newVolunteer = {
    ...incompleteNewVolunteer,
    naloxoneCompleted: true,
    naloxoneCompletedAt: 0,
    applicationComplete: isApplicationComplete(
      await loadApplicationProgress(env.DB, actor.id),
    ),
  };
  const expected = ["included-orientation", "legacy-orientation"];
  for (const view of ["volunteer", "manage"] as const) {
    const events = await listEvents(
      env.DB,
      newVolunteer,
      "regular-patrol",
      view,
    );
    assert.deepEqual(events.map((row) => row.id).sort(), expected);
  }
  // Supplying known IDs (or having an existing booking) must not bypass visibility.
  assert.deepEqual(
    (await listPublicRosters(env.DB, newVolunteer, ids)).people
      .map((row) => row.eventId)
      .sort(),
    expected,
  );
  await changeSignup(env.DB, newVolunteer, "regular-patrol", "cancel");
  await assert.rejects(
    changeSignup(env.DB, newVolunteer, "regular-patrol", "join"),
    statusError(403),
  );
  await env.DB.prepare(
    "INSERT INTO orientation_completion VALUES ('visibility-completion', ?, 'legacy-orientation', ?, 0)",
  )
    .bind(actor.id, organizer.id)
    .run();
  assert.deepEqual(
    (await listEvents(env.DB, newVolunteer)).map((row) => row.id).sort(),
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
    ...newVolunteer,
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
    applicationComplete: true,
    naloxoneCompleted: true,
    naloxoneCompletedAt: 0,
    applicationApproved: true,
    active: true,
  };
  const eventIds = ["orientation-one", "orientation-two"];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO profile (
      user_id, preferred_name, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, training_experience, registered_at, naloxone_completed_at, updated_at
    ) VALUES (?, 'Volunteer', '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', '[]', 'None', 'None', 0, 0, 0)`,
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
  for (const name of [
    { firstName: "" },
    { lastName: null },
    { middleNames: "a".repeat(201) },
  ])
    await assert.rejects(
      saveProfile(
        env.DB,
        actor.id,
        { ...answers, ...name },
        { actor, baseline: answers, intent: "edit" },
      ),
      statusError(400),
    );
  await saveProfile(
    env.DB,
    actor.id,
    {
      ...answers,
      firstName: "  Changed first  ",
      middleNames: " Changed middle ",
      lastName: " Changed last ",
      preferredName: "",
      phone: "604-555-0199",
      emergencyName: "Changed contact",
      medicalConditions: "Changed safety answer",
      teams: ["outreach", "non-patrol"],
      training: ["naloxone-administration"],
    },
    { actor, baseline: answers, intent: "edit" },
  );
  const latest = (await loadProfile(env.DB, actor.id))!;
  assert.equal(latest.phone, "604-555-0199");
  assert.equal(latest.firstName, "Changed first");
  assert.equal(latest.middleNames, "Changed middle");
  assert.equal(latest.lastName, "Changed last");
  assert.equal(
    await env.DB.prepare("SELECT name FROM user WHERE id=?")
      .bind(actor.id)
      .first("name"),
    "Changed first C.",
  );
  const organizer: Actor = {
    ...(await draftActor("snapshot-reviewer")),
    role: "organizer",
    applicationSubmitted: true,
    active: true,
    applicationApproved: true,
  };
  await saveProfile(env.DB, organizer.id, {
    ...answers,
    codeOfConductAccepted: true,
  });
  await env.DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
    .bind(organizer.id)
    .run();
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1 WHERE user_id=?",
  )
    .bind(organizer.id)
    .run();
  const review = await viewVolunteerProfile(env.DB, organizer, actor.id);
  assert.deepEqual(review?.answers, latest);
  const directory = await listApplications(env.DB, organizer, "Changed last");
  assert.equal(
    directory.rows.find(({ id }) => id === actor.id)?.name,
    "Changed first C.",
  );
  assert.deepEqual(review?.submission, submission);
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
    "UPDATE user SET name='Renamed preset' WHERE id LIKE 'local-account-v2-user-%'",
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
  for (const { id } of manualAccountPresets) {
    await assert.rejects(deleteLocalAccount(env.DB, id), statusError(403));
    assert.deepEqual(await snapshotTables(), beforePresets);
  }
  // A historical seeded ID remains protected after its preset key is renamed.
  const retiredPreset = await draftActor("local-account-user-medic-orientee");
  await saveProfile(env.DB, retiredPreset.id, answers);
  const retiredSubmission = await loadSubmittedApplication(
    env.DB,
    retiredPreset.id,
  );
  await assert.rejects(
    deleteLocalAccount(env.DB, retiredPreset.id),
    statusError(403),
  );
  assert.deepEqual(
    await loadSubmittedApplication(env.DB, retiredPreset.id),
    retiredSubmission,
  );
});

test("manual presets resolve real application completion, event access and roster categories", async () => {
  const now = Date.now();
  await env.DB.batch(
    localAccountFixtures(now).map((sql) => env.DB.prepare(sql)),
  );
  const { users, next } = await listLocalAccounts(env.DB);
  assert.equal(users.length, manualAccountPresets.length);
  assert.equal(next, null);
  const actors = new Map<string, Actor>();
  for (const preset of manualAccountPresets) {
    const row = users.find(({ id }) => id === preset.id)!;
    const progress = await loadApplicationProgress(env.DB, preset.id);
    const complete = isApplicationComplete(progress);
    assert.equal(
      complete,
      !preset.draft && preset.naloxoneCompleted && preset.applicationApproved,
      preset.label,
    );
    if (complete) {
      assert.ok(progress.submittedAt! <= progress.naloxoneCompletedAt!);
      assert.ok(
        progress.naloxoneCompletedAt! <= progress.applicationApprovedAt!,
      );
    }
    const sessionId = `preset-session-${preset.key}`;
    await env.DB.prepare(
      "INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(sessionId, row.id, sessionId, now + 60_000, now, now)
      .run();
    const actor: Actor = {
      id: row.id,
      name: row.name,
      sessionId,
      role: row.role,
      applicationSubmitted: row.state.submittedAt !== null,
      applicationComplete: complete,
      naloxoneCompleted: row.state.naloxoneCompletedAt !== null,
      applicationApproved: row.state.applicationApproved,
      patrolApproved: row.state.patrolApproved,
      active: row.state.active,
      twoFactorEnabled: false,
      twoFactorVerified: false,
    };
    actors.set(preset.key, actor);
    const events = await listEvents(env.DB, actor, undefined, "volunteer");
    assert.equal(
      events.length,
      !complete || !actor.active
        ? 0
        : actor.patrolApproved || actor.role === "organizer"
          ? 2
          : 1,
      preset.label,
    );
  }
  assert.equal(
    users.find(({ id }) => id === localAccountUserId("medic"))!.state
      .medicEligible,
    true,
  );
  assert.equal(
    users.find(({ id }) => id === localAccountUserId("medic-new-volunteer"))!
      .state.medicEligible,
    false,
  );
  assert.equal(
    users.find(({ id }) => id === localAccountUserId("orientation-completed"))!
      .state.patrolApproved,
    false,
  );
  assert.ok(await loadApplicationDraft(env.DB, localAccountUserId("draft")));
  assert.equal(actors.get("organizer")!.applicationApproved, true);
  assert.equal(actors.get("organizer")!.patrolApproved, true);
  const volunteers = await listVolunteers(env.DB, actors.get("organizer")!);
  assert.deepEqual(
    ["medic-new-volunteer", "medic", "patrol"].map(
      (key) =>
        volunteers.rows.find(({ id }) => id === localAccountUserId(key))!
          .category,
    ),
    ["new-volunteer", "medic", "outreach-volunteer"],
  );
  await changeSignup(
    env.DB,
    actors.get("organizer")!,
    "local-account-v2-event-patrol",
    "join",
  );
  await changeSignup(
    env.DB,
    actors.get("organizer")!,
    "local-account-v2-event-patrol",
    "cancel",
  );
  await changeSignup(
    env.DB,
    actors.get("medic")!,
    "local-account-v2-event-patrol",
    "join",
  );
  await changeSignup(
    env.DB,
    actors.get("patrol")!,
    "local-account-v2-event-patrol",
    "join",
  );
  // Jo is already booked alongside the long-name orientation sample.
  const roster = await listPublicRosters(env.DB, actors.get("organizer")!, [
    "local-account-v2-event-patrol",
    "local-account-v2-event-orientation",
  ]);
  assert.deepEqual(roster.people.map(({ category }) => category).sort(), [
    "medic",
    "new-volunteer",
    "new-volunteer",
    "outreach-volunteer",
  ]);

  const before = await loadSubmittedApplication(
    env.DB,
    localAccountUserId("medic"),
  );
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id=?",
  )
    .bind(localAccountUserId("medic"))
    .run();
  const changed = (await listLocalAccounts(env.DB)).users.find(
    ({ id }) => id === localAccountUserId("medic"),
  )!;
  assert.equal(changed.state.applicationApproved, false);
  assert.equal(changed.state.medicEligible, false);
  await env.DB.batch(
    localAccountFixtures(now + 1000).map((sql) => env.DB.prepare(sql)),
  );
  assert.equal(
    (await loadApplicationProgress(env.DB, changed.id)).applicationApproved,
    false,
  );
  assert.deepEqual(await loadSubmittedApplication(env.DB, changed.id), before);
});

test("state buttons reset one temporary account without accumulating saved accounts or changing saved work", async () => {
  const saved = await draftActor("saved-account");
  await saveProfile(env.DB, saved.id, {
    ...completeAnswers(),
    codeOfConductAccepted: true,
  });
  const original = await loadSubmittedApplication(env.DB, saved.id);
  const slot = crypto.randomUUID();
  const id = await resetAccountState(env.DB, "draft", slot);
  const firstDraft = await loadApplicationDraftState(env.DB, id);
  assert.ok(firstDraft.draft);
  const sessionId = "temporary-session";
  await env.DB.prepare(
    "INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,0,0)",
  )
    .bind(sessionId, id, sessionId, Date.now() + 60_000)
    .run();
  const actor: Actor = { ...saved, id, sessionId };
  for (const step of ["form", "naloxone", "discord", "review"] as const)
    await completeLocalApplicationStep(env.DB, actor, step);
  assert.ok(isApplicationComplete(await loadApplicationProgress(env.DB, id)));
  const count = await env.DB.prepare("SELECT count(*) AS n FROM user").first(
    "n",
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(await resetAccountState(env.DB, "draft", slot), id);
    assert.equal(await loadProfile(env.DB, id), null);
    const reset = await loadApplicationDraftState(env.DB, id);
    assert.ok(reset.draft);
    assert.notEqual(reset.generation, firstDraft.generation);
    assert.equal(reset.draft.answers.firstName, "Casey");
    assert.equal(
      await env.DB.prepare("SELECT count(*) AS n FROM user").first("n"),
      count,
    );
    assert.deepEqual(
      (await listLocalAccounts(env.DB)).users.map((user) => user.id),
      [saved.id],
    );
  }
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM session WHERE user_id=?")
      .bind(id)
      .first("n"),
    0,
  );
  assert.deepEqual(await loadSubmittedApplication(env.DB, saved.id), original);
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM event_notification").first(
      "n",
    ),
    0,
  );
});

test("every reusable state resolves its declared milestones, permissions and attendance without creating more identities", async () => {
  const slot = crypto.randomUUID();
  let id = "";
  for (const preset of [...manualAccountPresets, ...manualAccountPresets]) {
    const next = await resetAccountState(env.DB, preset.key, slot);
    if (id) assert.equal(next, id);
    else id = next;
    const progress = await loadApplicationProgress(env.DB, id);
    assert.equal(progress.submittedAt !== null, !preset.draft, preset.key);
    assert.equal(
      progress.naloxoneCompletedAt !== null,
      preset.naloxoneCompleted,
      preset.key,
    );
    assert.equal(
      progress.applicationApproved,
      preset.applicationApproved,
      preset.key,
    );
    const row = await env.DB.prepare(
      `SELECT u.role,v.active,v.patrol_approved,
      EXISTS(SELECT 1 FROM application_draft WHERE user_id=u.id) AS hasDraft,
      EXISTS(SELECT 1 FROM orientation_completion WHERE user_id=u.id) AS orientationCompleted,
      EXISTS(SELECT 1 FROM signup s JOIN event e ON e.id=s.event_id WHERE s.user_id=u.id
        AND s.status='confirmed' AND e.starts_at>?) AS orientationBooked,
      EXISTS(SELECT 1 FROM json_each(p.teams) WHERE value='medic') AS medicSelected
      FROM user u LEFT JOIN volunteer_status v ON v.user_id=u.id LEFT JOIN profile p ON p.user_id=u.id WHERE u.id=?`,
    )
      .bind(Date.now(), id)
      .first<{
        role: string;
        active: number | null;
        patrol_approved: number | null;
        hasDraft: number;
        orientationCompleted: number;
        orientationBooked: number;
        medicSelected: number;
      }>();
    assert.ok(row);
    assert.equal(row.role, preset.role, preset.key);
    assert.equal(
      Boolean(row.orientationCompleted),
      preset.orientation === "completed",
      preset.key,
    );
    assert.equal(
      Boolean(row.orientationBooked),
      preset.orientation === "booked",
      preset.key,
    );
    const actual = developmentAccountStatus({
      ...progress,
      hasDraft: Boolean(row.hasDraft),
      active: Boolean(row.active),
      patrolApproved: Boolean(row.patrol_approved),
      orientationCompleted: Boolean(row.orientationCompleted),
      orientationBooked: Boolean(row.orientationBooked),
      medicSelected: Boolean(row.medicSelected),
      medicEligible: Boolean(
        row.medicSelected &&
        row.patrol_approved &&
        row.active &&
        progress.applicationApproved,
      ),
      twoFactorEnabled: false,
    });
    assert.equal(actual, developmentPresetStatus(preset), preset.key);
    assert.equal(
      await env.DB.prepare("SELECT count(*) AS n FROM user").first("n"),
      2,
    );
    assert.deepEqual((await listLocalAccounts(env.DB)).users, []);
  }
  await resetAccountState(env.DB, "not-applied", slot);
  assert.equal(await loadApplicationDraft(env.DB, id), null);
  assert.equal(await loadProfile(env.DB, id), null);
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM user").first("n"),
    2,
  );
});

test("browser sandboxes are separate and reserved ID collisions cannot reset saved accounts", async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const [first, second] = await Promise.all([
    resetAccountState(env.DB, "draft", a),
    resetAccountState(env.DB, "applied", b),
  ]);
  assert.notEqual(first, second);
  assert.ok(await loadApplicationDraft(env.DB, first));
  assert.ok(await loadProfile(env.DB, second));
  const collision = crypto.randomUUID(),
    saved = await draftActor(`local-state-${collision}`);
  await assert.rejects(
    resetAccountState(env.DB, "draft", collision),
    statusError(409),
  );
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM session WHERE user_id=?")
      .bind(saved.id)
      .first("n"),
    1,
  );
});

test("development account state listing paginates without exposing draft answers or submission snapshots", async () => {
  await env.DB.batch(
    Array.from({ length: 105 }, (_, index) => {
      const id = `account-${String(index).padStart(3, "0")}`;
      return env.DB.prepare(
        "INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,0,0)",
      ).bind(id, id, `${id}@example.org`);
    }),
  );
  const first = await listLocalAccounts(env.DB);
  assert.equal(first.users.length, 100);
  assert.equal(first.next, "account-099");
  const second = await listLocalAccounts(env.DB, first.next!);
  assert.equal(second.users.length, 5);
  assert.equal(second.users[0].id, "account-100");
  assert.equal(second.next, null);
  assert.deepEqual(Object.keys(first.users[0]).sort(), [
    "email",
    "id",
    "name",
    "role",
    "state",
  ]);
  assert.equal(first.users[0].state.submittedAt, null);
  assert.equal(first.users[0].state.active, false);
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
  assert.equal(
    JSON.parse([...payloads.values()][0]).from,
    "After Hours Outreach <info@afterhoursoutreach.ca>",
  );

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
