import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { AuthBindings } from "../src/server/auth";
import type { Actor } from "../src/server/db/access";
import {
  addManualSignup,
  ensurePatrolOccurrences,
  savePatrolSeries,
} from "../src/server/db/events";
import { eventActionSchema } from "../src/server/events/actions";
import { RequestError } from "../src/server/http";
import {
  assertUnlocked,
  listPendingActions,
  runDuePendingActions,
  runPendingAction,
  schedulePendingAction,
  undoPendingAction,
} from "../src/server/pending-actions";

const bindings = env as unknown as AuthBindings;

// Accept every email batch without reaching the provider.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
    Response.json({
      data: (JSON.parse(String(init?.body)) as unknown[]).map((_, index) => ({
        id: `email-${index}`,
      })),
    }),
  );
  return () => vi.restoreAllMocks();
});
const statusError = (status: number) => (error: unknown) =>
  error instanceof RequestError && error.status === status;
const startsAt = Date.now() + 86_400_000;

async function organizer(id = "pending-organizer"): Promise<Actor> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?, ?, ?, 1, 'organizer', 0, 0)",
    ).bind(id, id, `${id}@example.org`),
    env.DB.prepare(
      "INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
    ).bind(`${id}-session`, id, `${id}-token`, Date.now() + 3_600_000),
    env.DB.prepare(
      `INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,
      emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,teams,
      medical_certification,training_experience,registered_at,naloxone_completed_at,updated_at)
      VALUES (?,?,'555','2000-01-01','Contact','555','Friend','Friend','Help','[]','None','None',0,0,0)`,
    ).bind(id, id),
    env.DB.prepare(
      `INSERT INTO volunteer_status (user_id,registration_approved,patrol_approved,approved_by,approved_at,updated_at)
      VALUES (?,1,1,?,0,0)`,
    ).bind(id, id),
  ]);
  return {
    id,
    name: id,
    role: "organizer",
    sessionId: `${id}-session`,
    twoFactorEnabled: false,
    twoFactorVerified: false,
    applicationSubmitted: true,
    applicationComplete: true,
    naloxoneCompleted: true,
    active: true,
    applicationApproved: true,
    patrolApproved: true,
  };
}

async function patrol(actor: Actor, id: string, spots: number, booked: number) {
  await env.DB.prepare(
    `INSERT INTO event (id,type,includes_orientation,starts_at,meeting_point,spots,
    min_medic_spots,min_new_volunteer_spots,max_new_volunteers,created_by,created_at,updated_at)
    VALUES (?,'patrol',0,?,'Point',?,0,0,2,?,0,0)`,
  )
    .bind(id, startsAt, spots, actor.id)
    .run();
  // One account registration, so the change emails someone.
  if (booked)
    await env.DB.prepare(
      `INSERT INTO signup (id, event_id, user_id, added_by, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'confirmed', 0, 0)`,
    )
      .bind(`${id}-account`, id, actor.id, actor.id)
      .run();
  for (let index = 1; index < booked; index++)
    await addManualSignup(env.DB, actor, id, {
      name: `Person ${index}`,
      medic: false,
      newVolunteer: false,
    });
}

// Moving the meeting point is emailed, so the change waits.
const save = (
  id: string,
  spots: number,
  notify = true,
  event: { meetingPoint?: string; meetingPointUrl?: string; open?: boolean } = {
    meetingPoint: "Moved",
  },
) =>
  eventActionSchema.parse({
    action: "save",
    id,
    version: 0,
    event: {
      includesOrientation: false,
      startsAt: new Date(startsAt).toISOString(),
      meetingPoint: "Point",
      meetingPointUrl: "",
      spots,
      open: true,
      hidden: !(event.open ?? true),
      ...event,
    },
    notify,
  });
const count = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .first<number>("n");

test("a waiting capacity cut holds its limit until it runs, and locks the event", async () => {
  const actor = await organizer();
  await patrol(actor, "held", 4, 2);
  const pending = await schedulePendingAction(
    bindings,
    actor,
    "events",
    save("held", 3),
  );
  assert.ok(pending);
  assert.equal(
    pending.action.summary.startsWith(
      "Changing the meeting point and spots of the event on",
    ),
    true,
  );
  assert.equal(pending.action.verb, "Change");
  const changes = [
    { label: "Meeting point", from: "Point", to: "Moved" },
    { label: "Volunteer spots", from: "4", to: "3" },
  ];
  assert.deepEqual(pending.action.changes, changes);
  // Changes without email never wait.
  assert.equal(
    await schedulePendingAction(
      bindings,
      actor,
      "events",
      save("held", 3, false),
    ),
    null,
  );
  await addManualSignup(env.DB, actor, "held", {
    name: "Third",
    medic: false,
    newVolunteer: false,
  });
  // The event still has 4 spots, but the waiting edit leaves room for 3.
  await assert.rejects(
    addManualSignup(env.DB, actor, "held", {
      name: "Fourth",
      medic: false,
      newVolunteer: false,
    }),
    statusError(409),
  );
  await assert.rejects(
    assertUnlocked(env.DB, "events", save("held", 5, false)),
    statusError(409),
  );
  await assert.rejects(
    schedulePendingAction(bindings, actor, "events", save("held", 5)),
    statusError(409),
  );
  const [listed] = await listPendingActions(env.DB, actor);
  assert.deepEqual(
    [listed.id, listed.mine, listed.status, listed.targets, listed.changes],
    [
      pending.action.id,
      true,
      "pending",
      [{ target: "event:held", locked: true }],
      changes,
    ],
  );
  // Not due yet, so the scheduler leaves it alone.
  await runDuePendingActions(bindings);
  assert.equal(await count("SELECT spots n FROM event WHERE id='held'"), 4);
  const result = await runPendingAction(bindings, pending.action.id, actor);
  assert.equal(result?.status, "done");
  assert.equal(await count("SELECT spots n FROM event WHERE id='held'"), 3);
  assert.equal(await count("SELECT count(*) n FROM event_capacity_hold"), 0);
  assert.equal(await count("SELECT count(*) n FROM pending_action_target"), 0);
  assert.equal(
    await runPendingAction(bindings, pending.action.id, actor),
    null,
  );
  await assertUnlocked(env.DB, "events", save("held", 5, false));
});

test("a capacity cut below the current roster is refused before it waits", async () => {
  const actor = await organizer();
  await patrol(actor, "full", 4, 3);
  await assert.rejects(
    schedulePendingAction(bindings, actor, "events", save("full", 2)),
    statusError(409),
  );
  assert.equal(await count("SELECT count(*) n FROM pending_action"), 0);
});

test("undo releases the hold and the lock, and cannot be repeated", async () => {
  const actor = await organizer();
  await patrol(actor, "undone", 4, 1);
  const pending = await schedulePendingAction(
    bindings,
    actor,
    "events",
    eventActionSchema.parse({
      action: "cancel-event",
      id: "undone",
      version: 0,
      reason: "",
      notify: true,
    }),
  );
  assert.ok(pending);
  assert.equal(pending.action.verb, "Cancel event");
  await undoPendingAction(env.DB, actor, pending.action.id);
  await assert.rejects(
    undoPendingAction(env.DB, actor, pending.action.id),
    statusError(409),
  );
  assert.equal(
    await count("SELECT cancelled_at IS NULL n FROM event WHERE id='undone'"),
    1,
  );
  assert.equal(await count("SELECT count(*) n FROM pending_action_target"), 0);
  assert.deepEqual(await listPendingActions(env.DB, actor), []);
});

test("cancelling or deleting an event waits even when it emails nobody", async () => {
  const actor = await organizer();
  await patrol(actor, "quiet", 4, 0);
  // An edit that emails nobody is made at once.
  assert.equal(
    await schedulePendingAction(
      bindings,
      actor,
      "events",
      save("quiet", 5, false),
    ),
    null,
  );
  for (const input of [
    { action: "cancel-event", reason: "" },
    { action: "delete-event" },
  ]) {
    const action = input.action;
    const pending = await schedulePendingAction(
      bindings,
      actor,
      "events",
      eventActionSchema.parse({
        ...input,
        id: "quiet",
        version: 0,
        notify: false,
      }),
    );
    assert.ok(pending, action);
    await undoPendingAction(env.DB, actor, pending.action.id);
  }
});

test("dropping the orientation with new volunteers booked is refused before it waits", async () => {
  const actor = await organizer();
  // An account booking, so the edit would email someone and wait.
  await patrol(actor, "oriented", 8, 1);
  await env.DB.prepare(
    "UPDATE event SET includes_orientation = 1 WHERE id = 'oriented'",
  ).run();
  await addManualSignup(env.DB, actor, "oriented", {
    name: "New person",
    medic: false,
    newVolunteer: true,
  });
  const version = (await env.DB.prepare(
    "SELECT updated_at AS v FROM event WHERE id = 'oriented'",
  ).first<number>("v"))!;
  const input = save("oriented", 8);
  if (input.action === "save") input.version = version;
  await assert.rejects(
    schedulePendingAction(bindings, actor, "events", input),
    (error: unknown) =>
      error instanceof RequestError &&
      error.status === 409 &&
      error.message.startsWith("New volunteers are registered"),
  );
  assert.equal(await count("SELECT count(*) n FROM pending_action"), 0);
  // Editing selected events the same way is refused just as early.
  await assert.rejects(
    schedulePendingAction(
      bindings,
      actor,
      "events",
      eventActionSchema.parse({
        action: "bulk-save",
        selection: [{ id: "oriented", version }],
        changes: { includesOrientation: false },
        notify: true,
      }),
    ),
    (error: unknown) =>
      error instanceof RequestError &&
      error.status === 409 &&
      error.message.startsWith("New volunteers are registered"),
  );
  assert.equal(await count("SELECT count(*) n FROM pending_action"), 0);
});

test("only the author can undo a waiting change or make it early", async () => {
  const actor = await organizer();
  const other = await organizer("pending-watcher");
  await patrol(actor, "watched", 4, 1);
  const pending = await schedulePendingAction(
    bindings,
    actor,
    "events",
    save("watched", 3),
  );
  assert.ok(pending);
  const [listed] = await listPendingActions(env.DB, other);
  assert.equal(listed.mine, false);
  await assert.rejects(
    undoPendingAction(env.DB, other, pending.action.id),
    statusError(403),
  );
  await assert.rejects(
    runPendingAction(bindings, pending.action.id, other),
    statusError(403),
  );
  assert.equal(await count("SELECT spots n FROM event WHERE id='watched'"), 4);
  await undoPendingAction(env.DB, actor, pending.action.id);
});

test("due actions run as their author, signed out or not, and fail visibly once they lose access", async () => {
  const actor = await organizer();
  const other = await organizer("pending-other");
  const demoted = await organizer("pending-demoted");
  await patrol(actor, "due", 4, 1);
  await patrol(actor, "orphan", 4, 1);
  await patrol(actor, "lost", 4, 1);
  const due = await schedulePendingAction(
    bindings,
    actor,
    "events",
    save("due", 3),
  );
  const orphan = await schedulePendingAction(
    bindings,
    other,
    "events",
    save("orphan", 3),
  );
  const lost = await schedulePendingAction(
    bindings,
    demoted,
    "events",
    save("lost", 3),
  );
  assert.ok(due && orphan && lost);
  await env.DB.prepare("UPDATE pending_action SET run_at = 0").run();
  await env.DB.prepare("DELETE FROM session WHERE user_id = ?")
    .bind(other.id)
    .run();
  await env.DB.prepare("UPDATE user SET role = 'volunteer' WHERE id = ?")
    .bind(demoted.id)
    .run();
  await runDuePendingActions(bindings);
  assert.equal(await count("SELECT spots n FROM event WHERE id='due'"), 3);
  assert.equal(await count("SELECT spots n FROM event WHERE id='orphan'"), 3);
  assert.equal(await count("SELECT spots n FROM event WHERE id='lost'"), 4);
  // The session made for the signed-out run is gone again.
  assert.equal(
    await count("SELECT count(*) n FROM session WHERE user_id = ?", other.id),
    0,
  );
  assert.equal(
    await env.DB.prepare("SELECT status FROM pending_action WHERE id = ?")
      .bind(lost.action.id)
      .first("status"),
    "failed",
  );
  // The failure is shown to its author until dismissed, not to others.
  assert.deepEqual(await listPendingActions(env.DB, actor), []);
});

test("the timer ends before the event starts, is skipped when too soon, and cancelling always gets a minute", async () => {
  const actor = await organizer();
  const soon = Date.now() + 20 * 60_000;
  await patrol(actor, "soon", 4, 1);
  await patrol(actor, "now", 4, 1);
  await env.DB.batch([
    env.DB.prepare("UPDATE event SET starts_at = ? WHERE id = 'soon'").bind(
      soon,
    ),
    env.DB.prepare("UPDATE event SET starts_at = ? WHERE id = 'now'").bind(
      Date.now() + 10 * 60_000,
    ),
  ]);
  const cancel = (id: string) =>
    eventActionSchema.parse({
      action: "cancel-event",
      id,
      version: 0,
      reason: "",
      notify: true,
    });
  const pending = await schedulePendingAction(
    bindings,
    actor,
    "events",
    cancel("soon"),
  );
  assert.ok(pending);
  assert.ok(Math.abs(pending.action.runAt - (soon - 15 * 60_000)) < 1_000);
  // Too close for the usual wait: an edit is made at once, but cancelling
  // still gets a minute to undo.
  assert.equal(
    await schedulePendingAction(bindings, actor, "events", save("now", 5)),
    null,
  );
  const close = await schedulePendingAction(
    bindings,
    actor,
    "events",
    cancel("now"),
  );
  assert.ok(close);
  assert.ok(Math.abs(close.action.runAt - Date.now() - 60_000) < 1_000);
});

test("moving a series' last date before its upcoming dates waits even when it emails nobody", async () => {
  const actor = await organizer();
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const series = {
    firstDate: day(2),
    localTime: "18:00",
    intervalWeeks: 1,
    endDate: null,
    meetingPoint: "Point",
    meetingPointUrl: "",
    spots: 8,
    open: true,
    hidden: false,
    includesOrientation: false,
  };
  const { id } = await savePatrolSeries(env.DB, actor, series);
  await ensurePatrolOccurrences(env.DB, id);
  const version = (await env.DB.prepare(
    "SELECT updated_at AS v FROM patrol_series WHERE id = ?",
  )
    .bind(id)
    .first<number>("v"))!;
  const shorten = (endDate: string) =>
    eventActionSchema.parse({
      action: "save-series",
      id,
      version,
      series: { ...series, endDate },
      notify: false,
    });
  // An end date after every generated date drops nothing, so it is made at once.
  assert.equal(
    await schedulePendingAction(bindings, actor, "events", shorten(day(400))),
    null,
  );
  const pending = await schedulePendingAction(
    bindings,
    actor,
    "events",
    shorten(day(3)),
  );
  assert.ok(pending);
  await undoPendingAction(env.DB, actor, pending.action.id);
});

test("a refused change names the waiting change that blocks it", async () => {
  const actor = await organizer();
  await patrol(actor, "blocked", 4, 1);
  const pending = await schedulePendingAction(
    bindings,
    actor,
    "events",
    save("blocked", 3),
  );
  assert.ok(pending);
  await assert.rejects(
    assertUnlocked(env.DB, "events", save("blocked", 5, false)),
    (error) =>
      error instanceof RequestError &&
      error.details?.pendingActionId === pending.action.id,
  );
});

test("changes that would email nobody are made straight away", async () => {
  const actor = await organizer();
  await patrol(actor, "unbooked", 4, 0);
  await addManualSignup(env.DB, actor, "unbooked", {
    name: "Name only",
    medic: false,
    newVolunteer: false,
  });
  assert.equal(
    await schedulePendingAction(bindings, actor, "events", save("unbooked", 3)),
    null,
  );
});

test("edits volunteers are not emailed about are made straight away", async () => {
  const actor = await organizer();
  await patrol(actor, "quiet", 4, 1);
  for (const event of [
    {},
    { meetingPointUrl: "https://maps.example/point" },
    { open: false },
  ])
    assert.equal(
      await schedulePendingAction(
        bindings,
        actor,
        "events",
        save("quiet", 3, true, event),
      ),
      null,
    );
  assert.equal(
    await schedulePendingAction(
      bindings,
      actor,
      "events",
      eventActionSchema.parse({
        action: "bulk-save",
        selection: [{ id: "quiet", version: 0 }],
        changes: { spots: 3, unregisterMinutes: 60 },
        notify: true,
      }),
    ),
    null,
  );
});
