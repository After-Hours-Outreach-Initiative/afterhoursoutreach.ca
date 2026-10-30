import assert from "node:assert/strict";
import { test } from "vitest";
import { env } from "cloudflare:workers";
import type { Actor } from "../src/server/db/access";
import {
  consumeDiscordState,
  finishDiscordLink,
  startDiscordLink,
} from "../src/server/discord/oauth";
import { decryptToken } from "../src/server/discord/crypto";
import {
  discordConfigured,
  managedRoles,
  type DiscordBindings,
} from "../src/server/discord/config";
import { eligibleRoles, processDiscordSync } from "../src/server/discord/sync";
import { loadDiscordStatus } from "../src/server/discord/status";
import {
  isApplicationComplete,
  loadApplicationProgress,
} from "../src/server/db/application-progress";
import { setVolunteerStatus } from "../src/server/db/volunteers";
import { deleteOwnAccount } from "../src/server/db/account-deletion";
import { RequestError } from "../src/server/http";
import {
  loadLocalDiscordStatus,
  simulateDiscordConnection,
} from "../src/dev/server/discord";
import {
  discordConnectionIdentity,
  discordConnectionMessage,
} from "../src/data/discord-connection";

const config: DiscordBindings = {
  ...env,
  DISCORD_CLIENT_ID: "100000000000000001",
  DISCORD_GUILD_ID: "100000000000000002",
  DISCORD_VOLUNTEER_ROLE_ID: "100000000000000003",
  DISCORD_ORGANIZER_ROLE_ID: "100000000000000004",
  DISCORD_MEDIC_ROLE_ID: "100000000000000005",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_BOT_TOKEN: "test-bot-token",
  DISCORD_TOKEN_ENCRYPTION_KEY: btoa("01234567890123456789012345678901"),
};
const origin = "https://afterhoursoutreach.ca",
  identity = "200000000000000001";
const statusError = (status: number) => (error: unknown) =>
  error instanceof RequestError && error.status === status;

async function person(id = "alice", organizer = false): Promise<Actor> {
  await env.DB.prepare(
    "INSERT INTO user (id,name,email,email_verified,role,created_at,updated_at) VALUES (?,?,?,1,?,0,0)",
  )
    .bind(id, id, `${id}@example.org`, organizer ? "organizer" : "volunteer")
    .run();
  await env.DB.prepare(
    "INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,0,0)",
  )
    .bind(`${id}-session`, id, `${id}-token`, Date.now() + 3_600_000)
    .run();
  await env.DB.prepare(
    `INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,
    emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,teams,
    medical_certification,training_experience,registered_at,updated_at,naloxone_completed_at)
    VALUES (?,?,'555','2000-01-01','Contact','555','Friend','Friend','Help','["outreach","medic"]','None','None',0,0,1)`,
  )
    .bind(id, id)
    .run();
  await env.DB.prepare(
    "INSERT INTO volunteer_status (user_id,registration_approved,updated_at) VALUES (?,0,0)",
  )
    .bind(id)
    .run();
  return {
    id,
    name: id,
    sessionId: `${id}-session`,
    role: organizer ? "organizer" : "volunteer",
    twoFactorEnabled: false,
    twoFactorVerified: false,
    applicationSubmitted: true,
    applicationComplete: false,
    naloxoneCompleted: true,
    active: true,
    applicationApproved: false,
    patrolApproved: false,
  };
}
function oauthFetch(discordId = identity): typeof fetch {
  return async (input, init) => {
    if (String(input).endsWith("/oauth2/token")) {
      assert.ok(String(init?.body).includes("code_verifier="));
      return Response.json({
        access_token: "private-user-access-token",
        refresh_token: "never-store-this",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "identify guilds.join",
      });
    }
    assert.equal(String(input), "https://discord.com/api/v10/users/@me");
    return Response.json({ id: discordId, username: "volunteer" });
  };
}
async function link(actor: Actor, discordId = identity) {
  await finishDiscordLink(
    config,
    actor,
    origin,
    "code",
    "verifier",
    oauthFetch(discordId),
  );
}
function discordServer(initialRoles: string[] = [], initialMember = true) {
  const state = {
    roles: [...initialRoles],
    member: initialMember,
    pending: false,
    calls: [] as { path: string; method: string }[],
  };
  const send: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname,
      method = init?.method ?? "GET";
    state.calls.push({ path, method });
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bot ${config.DISCORD_BOT_TOKEN}`,
    );
    if (!path.includes("/roles/")) {
      if (method === "GET")
        return state.member
          ? Response.json({
              user: { id: identity },
              roles: state.roles,
              pending: state.pending,
              joined_at: "2026-01-01T00:00:00Z",
            })
          : Response.json({ code: 10007 }, { status: 404 });
      assert.equal(method, "PUT");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        access_token: "private-user-access-token",
      });
      state.member = true;
      return new Response(null, { status: 201 });
    }
    const role = path.split("/").at(-1)!;
    assert.ok(Object.values(managedRoles(config)).includes(role));
    if (method === "PUT") {
      if (!state.roles.includes(role)) state.roles.push(role);
    } else {
      assert.equal(method, "DELETE");
      state.roles = state.roles.filter((id) => id !== role);
    }
    return new Response(null, { status: 204 });
  };
  return { state, send };
}
async function due() {
  await env.DB.prepare("UPDATE discord_link SET next_attempt_at=0").run();
  await env.DB.prepare(
    "UPDATE discord_worker SET not_before=0,request_window=0,request_count=0",
  ).run();
}

test("deleted accounts retain retryable Discord removal until all managed roles are gone, without kicking or rejoining", async () => {
  for (const member of [true, false]) {
    const actor = await person(member ? "deleted-member" : "deleted-nonmember");
    await link(actor);
    await env.DB.prepare("UPDATE session SET created_at=? WHERE id=?")
      .bind(Date.now(), actor.sessionId)
      .run();
    await deleteOwnAccount(
      env.DB,
      { userId: actor.id, sessionId: actor.sessionId },
      {
        userId: actor.id,
        email: `${actor.id}@example.org`,
        confirm: true,
      },
    );
    await processDiscordSync(
      config,
      async () => new Response(null, { status: 503 }),
    );
    assert.ok(
      await env.DB.prepare("SELECT user_id FROM discord_link WHERE user_id=?")
        .bind(actor.id)
        .first(),
    );
    await due();
    const discord = discordServer(
      [...Object.values(managedRoles(config)), "unrelated-role"],
      member,
    );
    await processDiscordSync(config, discord.send);
    assert.equal(
      await env.DB.prepare("SELECT user_id FROM discord_link WHERE user_id=?")
        .bind(actor.id)
        .first(),
      null,
    );
    assert.deepEqual(
      discord.state.roles,
      member
        ? ["unrelated-role"]
        : [...Object.values(managedRoles(config)), "unrelated-role"],
    );
    assert.ok(
      discord.state.calls.every(
        (call) =>
          call.method === "GET" ||
          (call.method === "DELETE" && call.path.includes("/roles/")),
      ),
    );
  }
});

test("Discord uses only the three allowed roles, all gated by active application approval", () => {
  const roles = managedRoles(config),
    base = {
      active: 1,
      approved: 1,
      organizer: 1,
      medic: 1,
      patrol: 1,
    };
  assert.deepEqual(eligibleRoles(base, roles), Object.values(roles));
  for (const field of ["active", "approved"] as const)
    assert.deepEqual(eligibleRoles({ ...base, [field]: 0 }, roles), []);
  for (const field of ["medic", "patrol"] as const)
    assert.deepEqual(eligibleRoles({ ...base, [field]: 0 }, roles), [
      roles.volunteer,
      roles.organizer,
    ]);
  assert.deepEqual(eligibleRoles({ ...base, organizer: 0 }, roles), [
    roles.volunteer,
    roles.medic,
  ]);
  assert.equal(discordConfigured({ ...config, APP_ENV: "preview" }), false);
  assert.equal(
    discordConfigured({
      ...config,
      DISCORD_MEDIC_ROLE_ID: config.DISCORD_VOLUNTEER_ROLE_ID,
    }),
    false,
  );
});

test("local Discord simulation preserves consent and screening, then reconciles eligible roles without tokens", async () => {
  const actor = await person();
  const input = { userId: actor.id, consent: true, outcome: "authorize" };
  assert.equal((await loadLocalDiscordStatus(config, actor.id)).notice, null);
  await assert.rejects(
    simulateDiscordConnection(env.DB, actor, { ...input, consent: false }),
    statusError(400),
  );
  await assert.rejects(
    simulateDiscordConnection(env.DB, actor, { ...input, userId: "other" }),
    statusError(403),
  );
  await assert.rejects(
    simulateDiscordConnection(env.DB, actor, {
      ...input,
      outcome: "unavailable",
    }),
    statusError(503),
  );
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM discord_link").first("n"),
    0,
  );
  await simulateDiscordConnection(env.DB, actor, {
    ...input,
    outcome: "screening",
  });
  const pending = await loadLocalDiscordStatus(config, actor.id);
  assert.equal(pending.configured, true);
  assert.equal(pending.completedAt, null);
  assert.equal(pending.needsReconnect, false);
  assert.match(pending.connection, /Accept the server rules/);
  assert.equal(pending.notice, pending.connection);
  assert.equal(discordConnectionMessage(pending), pending.connection);
  assert.equal(
    discordConnectionIdentity(pending),
    "Connected as @aho_volunteer",
  );
  assert.equal(
    (await loadApplicationProgress(env.DB, actor.id)).discordCompletedAt,
    null,
  );

  await simulateDiscordConnection(env.DB, actor, input);
  const connected = await loadLocalDiscordStatus(config, actor.id);
  assert.ok(connected.completedAt);
  assert.equal(connected.needsReconnect, false);
  assert.match(connected.sync, /Roles synchronized/);
  assert.equal(connected.notice, null);
  assert.equal(discordConnectionMessage(connected), "");
  const local = () =>
    env.DB.prepare("SELECT * FROM discord_link WHERE user_id=?")
      .bind(actor.id)
      .first<{
        guild_id: string;
        discord_id: string;
        observed_roles: string;
        join_token: string | null;
        token_expires_at: number | null;
        version: number;
        synced_version: number;
      }>();
  assert.equal((await local())!.guild_id, "local-only");
  assert.equal((await local())!.discord_id, `local:${actor.id}`);
  assert.equal((await local())!.join_token, null);
  assert.equal((await local())!.token_expires_at, null);
  assert.deepEqual(JSON.parse((await local())!.observed_roles), []);

  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  await loadLocalDiscordStatus(config, actor.id);
  assert.deepEqual(JSON.parse((await local())!.observed_roles), [
    "local-volunteer",
  ]);
  assert.equal((await local())!.version, (await local())!.synced_version);
  await person("organizer", true);
  await env.DB.prepare(
    "UPDATE volunteer_status SET patrol_approved=1,approved_by='organizer',approved_at=1 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  await loadLocalDiscordStatus(config, actor.id);
  assert.deepEqual(JSON.parse((await local())!.observed_roles), [
    "local-volunteer",
    "local-medic",
  ]);
  assert.equal(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM orientation_completion",
    ).first("n"),
    0,
  );
  // Reconcile already-synced simulations created under the old attendance rule.
  const syncedVersion = (await local())!.version;
  await env.DB.prepare(
    "UPDATE discord_link SET observed_roles='[\"local-volunteer\"]' WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  await loadLocalDiscordStatus(config, actor.id);
  assert.equal((await local())!.version, syncedVersion);
  assert.deepEqual(JSON.parse((await local())!.observed_roles), [
    "local-volunteer",
    "local-medic",
  ]);
  await env.DB.prepare("UPDATE volunteer_status SET active=0 WHERE user_id=?")
    .bind(actor.id)
    .run();
  await loadLocalDiscordStatus(config, actor.id);
  assert.deepEqual(JSON.parse((await local())!.observed_roles), []);
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM discord_oauth").first("n"),
    0,
  );
});

test("local Discord simulation rechecks prerequisites and session authorization and never replaces real links", async () => {
  const actor = await person();
  const input = { userId: actor.id, consent: true, outcome: "authorize" };
  await env.DB.prepare("UPDATE profile SET naloxone_completed_at=NULL").run();
  await assert.rejects(
    simulateDiscordConnection(env.DB, actor, input),
    statusError(409),
  );
  await env.DB.prepare("UPDATE profile SET naloxone_completed_at=1").run();
  await assert.rejects(
    simulateDiscordConnection(
      env.DB,
      { ...actor, twoFactorEnabled: true, twoFactorVerified: false },
      input,
    ),
    statusError(401),
  );
  await link(actor);
  const before = await env.DB.prepare(
    "SELECT * FROM discord_link WHERE user_id=?",
  )
    .bind(actor.id)
    .first();
  await assert.rejects(
    simulateDiscordConnection(env.DB, actor, input),
    statusError(409),
  );
  await loadLocalDiscordStatus(config, actor.id);
  assert.deepEqual(
    await env.DB.prepare("SELECT * FROM discord_link WHERE user_id=?")
      .bind(actor.id)
      .first(),
    before,
  );
  await env.DB.prepare("UPDATE session SET expires_at=0").run();
  await assert.rejects(
    simulateDiscordConnection(env.DB, actor, input),
    statusError(409),
  );
});

test("unconfigured Discord exposes availability without user-facing setup instructions", async () => {
  const actor = await person();
  const disabled = { ...config, DISCORD_BOT_TOKEN: "" };
  const status = await loadDiscordStatus(disabled, actor.id);
  assert.equal(status.configured, false);
  assert.doesNotMatch(status.sync, /not configured|organizer|secret|token/i);
  await assert.rejects(
    startDiscordLink(disabled, actor, origin, {
      userId: actor.id,
      consent: true,
    }),
    (error: unknown) =>
      error instanceof RequestError &&
      error.status === 503 &&
      error.message === "Discord connection is coming soon.",
  );
});

test("OAuth consent, order, PKCE and single-use state bind the browser, account, session and origin", async () => {
  const actor = await person();
  await assert.rejects(
    startDiscordLink(config, actor, origin, {
      userId: actor.id,
      consent: false,
    }),
    statusError(400),
  );
  await assert.rejects(
    startDiscordLink(config, actor, origin, { userId: "other", consent: true }),
    statusError(403),
  );
  await env.DB.prepare("UPDATE profile SET naloxone_completed_at=NULL").run();
  await assert.rejects(
    startDiscordLink(config, actor, origin, {
      userId: actor.id,
      consent: true,
    }),
    statusError(409),
  );
  await env.DB.prepare("UPDATE profile SET naloxone_completed_at=1").run();
  const first = await startDiscordLink(config, actor, origin, {
    userId: actor.id,
    consent: true,
  });
  const next = await startDiscordLink(config, actor, origin, {
    userId: actor.id,
    consent: true,
  });
  const url = new URL(next.url),
    state = url.searchParams.get("state")!;
  assert.equal(url.searchParams.get("scope"), "identify guilds.join");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge")!.length, 43);
  await assert.rejects(
    consumeDiscordState(
      config,
      actor,
      origin,
      new URL(first.url).searchParams.get("state")!,
      first.browser,
    ),
    statusError(403),
  );
  for (const [who, site, browser] of [
    [{ ...actor, id: "other" }, origin, next.browser],
    [{ ...actor, sessionId: "other" }, origin, next.browser],
    [actor, "https://other.example", next.browser],
    [actor, origin, first.browser],
  ] as const)
    await assert.rejects(
      consumeDiscordState(config, who, site, state, browser),
      statusError(403),
    );
  const verifier = await consumeDiscordState(
    config,
    actor,
    origin,
    state,
    next.browser,
  );
  assert.equal(verifier.length, 43);
  await assert.rejects(
    consumeDiscordState(config, actor, origin, state, next.browser),
    statusError(403),
  );
});

test("expired/revoked or second-factor-incomplete sessions cannot consume OAuth or persist links", async () => {
  const actor = await person(),
    started = await startDiscordLink(config, actor, origin, {
      userId: actor.id,
      consent: true,
    });
  await assert.rejects(
    startDiscordLink(config, { ...actor, twoFactorEnabled: true }, origin, {
      userId: actor.id,
      consent: true,
    }),
    statusError(401),
  );
  await env.DB.prepare("UPDATE discord_oauth SET expires_at=0").run();
  await assert.rejects(
    consumeDiscordState(
      config,
      actor,
      origin,
      new URL(started.url).searchParams.get("state")!,
      started.browser,
    ),
    statusError(403),
  );
  await env.DB.prepare("DELETE FROM session").run();
  await assert.rejects(link(actor), statusError(409));
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM discord_link").first("n"),
    0,
  );
});

test("identity ownership is unique and immutable; only same-identity reauthorization can refresh encrypted consent", async () => {
  const actor = await person(),
    bob = await person("bob");
  await link(actor);
  const row = await env.DB.prepare("SELECT * FROM discord_link").first<{
    join_token: string;
  }>();
  assert.ok(row);
  assert.equal(
    JSON.stringify(row).includes("private-user-access-token"),
    false,
  );
  assert.equal(JSON.stringify(row).includes("never-store-this"), false);
  assert.equal(
    await decryptToken(
      config.DISCORD_TOKEN_ENCRYPTION_KEY!,
      row.join_token,
      `${actor.id}:${identity}:${config.DISCORD_GUILD_ID}`,
    ),
    "private-user-access-token",
  );
  await assert.rejects(
    decryptToken(
      config.DISCORD_TOKEN_ENCRYPTION_KEY!,
      row.join_token,
      "different-account",
    ),
  );
  await assert.rejects(link(bob), statusError(409));
  await assert.rejects(link(actor, "200000000000000002"), statusError(409));
  await link(actor);
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM discord_link").first("n"),
    1,
  );
  await assert.rejects(
    env.DB.prepare(
      "UPDATE discord_link SET discord_id='200000000000000002'",
    ).run(),
    /discord_identity_immutable/,
  );
});

test("consented auto-join requires a separate verified membership check before the required step completes", async () => {
  const actor = await person();
  await link(actor);
  const pending = await loadDiscordStatus(config, actor.id);
  assert.equal(pending.notice, "Joining and verifying server membership");
  assert.equal(discordConnectionIdentity(pending), "Connected as @volunteer");
  const server = discordServer([], false);
  assert.equal(
    isApplicationComplete({
      ...(await loadApplicationProgress(env.DB, actor.id)),
      applicationApproved: true,
    }),
    // Discord linking is paused; pending membership must not block the application.
    true,
  );
  await processDiscordSync(config, server.send);
  assert.deepEqual(
    server.state.calls.map(({ method }) => method),
    ["GET", "PUT", "GET"],
  );
  const progress = await loadApplicationProgress(env.DB, actor.id);
  assert.equal(progress.discordRequired, true);
  assert.ok(progress.discordCompletedAt);
  assert.equal(
    isApplicationComplete({ ...progress, applicationApproved: true }),
    true,
  );
  assert.equal(
    (await env.DB.prepare("SELECT join_token FROM discord_link").first())
      ?.join_token,
    null,
  );
  assert.deepEqual(server.state.roles, []); // unapproved applicants get no roles
});

test("Membership Screening cannot complete the step or be bypassed by role assignment", async () => {
  const actor = await person();
  await link(actor);
  const server = discordServer([config.DISCORD_VOLUNTEER_ROLE_ID]);
  server.state.pending = true;
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1",
  ).run();
  await processDiscordSync(config, server.send);
  assert.deepEqual(server.state.roles, []);
  assert.equal(
    (await loadApplicationProgress(env.DB, actor.id)).discordCompletedAt,
    null,
  );
  assert.match(
    (await loadDiscordStatus(config, actor.id)).connection,
    /screening/,
  );
  server.state.pending = false;
  await due();
  await processDiscordSync(config, server.send);
  assert.ok(
    (await loadApplicationProgress(env.DB, actor.id)).discordCompletedAt,
  );
  assert.deepEqual(server.state.roles, [config.DISCORD_VOLUNTEER_ROLE_ID]);
});

test("approval requires Naloxone but not Discord while linking is paused; legacy applicants remain exempt", async () => {
  const organizer = {
    ...(await person("organizer", true)),
    applicationApproved: true,
    applicationComplete: true,
  };
  const actor = await person();
  const input = {
    userId: actor.id,
    version: 0,
    active: true,
    applicationApproved: true,
    patrolApproved: false,
  };
  await env.DB.prepare(
    "UPDATE profile SET naloxone_completed_at=NULL WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  await assert.rejects(
    setVolunteerStatus(env.DB, organizer, input),
    statusError(409),
  );
  await env.DB.prepare(
    "UPDATE profile SET naloxone_completed_at=1 WHERE user_id=?",
  )
    .bind(actor.id)
    .run();
  // Discord connection is temporarily disabled.
  // await link(actor);
  // await processDiscordSync(config, discordServer().send);
  await setVolunteerStatus(env.DB, organizer, input);
  const progress = await loadApplicationProgress(env.DB, actor.id);
  assert.equal(progress.discordRequired, true); // Preserve the future requirement.
  assert.equal(progress.discordCompletedAt, null); // Never invent a connection.
  assert.equal(isApplicationComplete(progress), true);
  assert.equal(
    isApplicationComplete({ ...progress, naloxoneCompletedAt: null }),
    false,
  );
  assert.equal(
    isApplicationComplete({ ...progress, applicationApproved: false }),
    false,
  );
  const legacy = await person("legacy");
  // Represents an existing submitted profile: migration never creates this row.
  await env.DB.prepare("DELETE FROM discord_requirement WHERE user_id=?")
    .bind(legacy.id)
    .run();
  await setVolunteerStatus(env.DB, organizer, { ...input, userId: legacy.id });
  assert.equal(
    isApplicationComplete(await loadApplicationProgress(env.DB, legacy.id)),
    true,
  );
});

test("website changes automatically remove and restore eligible roles without touching unrelated roles or membership", async () => {
  const actor = await person();
  await person("organizer", true);
  await link(actor);
  const unrelated = "300000000000000001",
    server = discordServer([unrelated]);
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1,patrol_approved=1,approved_by='organizer',approved_at=1 WHERE user_id='alice'",
  ).run();
  await env.DB.prepare(
    "UPDATE user SET role='organizer' WHERE id='alice'",
  ).run();
  await env.DB.prepare(
    "INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at) VALUES ('orientation','orientation',0,'Point',4,'organizer',0,0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO orientation_completion (id,user_id,event_id,marked_by,marked_at) VALUES ('done','alice','orientation','organizer',0)",
  ).run();
  await processDiscordSync(config, server.send);
  assert.equal((await loadDiscordStatus(config, actor.id)).notice, null);
  assert.deepEqual(
    new Set(server.state.roles),
    new Set([unrelated, ...Object.values(managedRoles(config))]),
  );
  await env.DB.prepare(
    "UPDATE volunteer_status SET active=0 WHERE user_id='alice'",
  ).run();
  const pendingRoles = await loadDiscordStatus(config, actor.id);
  assert.match(pendingRoles.sync, /Role sync pending/);
  assert.equal(pendingRoles.notice, null);
  await due();
  await processDiscordSync(config, server.send);
  assert.deepEqual(server.state.roles, [unrelated]);
  await env.DB.prepare(
    "UPDATE volunteer_status SET active=1 WHERE user_id='alice'",
  ).run();
  await due();
  await processDiscordSync(config, server.send);
  assert.equal(server.state.roles.length, 4);
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='alice'",
  ).run();
  await due();
  await processDiscordSync(config, server.send);
  assert.deepEqual(server.state.roles, [unrelated]);
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1 WHERE user_id='alice'",
  ).run();
  await due();
  await processDiscordSync(config, server.send);
  assert.equal(server.state.roles.length, 4);
  const versionBeforeAttendance = await env.DB.prepare(
    "SELECT version FROM discord_link WHERE user_id='alice'",
  ).first("version");
  await env.DB.prepare("DELETE FROM orientation_completion").run();
  assert.equal(
    await env.DB.prepare(
      "SELECT version FROM discord_link WHERE user_id='alice'",
    ).first("version"),
    versionBeforeAttendance,
  );
  await due();
  await processDiscordSync(config, server.send);
  assert.equal(server.state.roles.includes(config.DISCORD_MEDIC_ROLE_ID), true);
  await env.DB.prepare(
    "UPDATE volunteer_status SET patrol_approved=0 WHERE user_id='alice'",
  ).run();
  await due();
  await processDiscordSync(config, server.send);
  assert.equal(
    server.state.roles.includes(config.DISCORD_MEDIC_ROLE_ID),
    false,
  );
  await env.DB.prepare(
    "UPDATE volunteer_status SET patrol_approved=1 WHERE user_id='alice'",
  ).run();
  await due();
  await processDiscordSync(config, server.send);
  assert.equal(server.state.roles.includes(config.DISCORD_MEDIC_ROLE_ID), true);
  await env.DB.prepare(
    "UPDATE user SET role='volunteer' WHERE id='alice'",
  ).run();
  await due();
  await processDiscordSync(config, server.send);
  assert.deepEqual(server.state.roles, [
    unrelated,
    config.DISCORD_VOLUNTEER_ROLE_ID,
    config.DISCORD_MEDIC_ROLE_ID,
  ]);
  assert.equal(server.state.member, true);
  assert.ok(
    server.state.calls.every(
      (call) => call.method !== "DELETE" || call.path.includes("/roles/"),
    ),
  );
});

test("team edits and manual status changes enqueue reconciliation in the same transaction", async () => {
  const actor = await person();
  await link(actor);
  const before = await env.DB.prepare(
    "SELECT version FROM discord_link",
  ).first<number>("version");
  await env.DB.prepare("UPDATE profile SET teams='[\"outreach\"]'").run();
  assert.equal(
    await env.DB.prepare("SELECT version FROM discord_link").first("version"),
    before! + 1,
  );
  await env.DB.prepare("DELETE FROM volunteer_status").run();
  assert.equal(
    await env.DB.prepare("SELECT version FROM discord_link").first("version"),
    before! + 2,
  );
  assert.equal(
    await env.DB.prepare("SELECT next_attempt_at FROM discord_link").first(
      "next_attempt_at",
    ),
    0,
  );
});

test("durable rate-limit cooldowns survive concurrent workers and eligibility changes", async () => {
  const actor = await person();
  await link(actor);
  let calls = 0;
  const limited: typeof fetch = async () => {
    calls++;
    return Response.json(
      { retry_after: 120.5, global: true },
      { status: 429, headers: { "Retry-After": "121" } },
    );
  };
  await Promise.all([
    processDiscordSync(config, limited),
    processDiscordSync(config, limited),
  ]);
  assert.equal(calls, 1);
  const pause = await env.DB.prepare(
    "SELECT not_before FROM discord_worker",
  ).first<number>("not_before");
  assert.ok(pause! > Date.now() + 120_000);
  await env.DB.prepare("UPDATE volunteer_status SET active=0").run();
  await processDiscordSync(config, limited);
  assert.equal(calls, 1);
  const status = await loadDiscordStatus(config, actor.id);
  assert.match(status.sync, /pause/);
  assert.equal(status.notice, status.sync);
});

test("successful exhausted-bucket headers pause subsequent requests without losing the durable reconciliation cursor", async () => {
  const actor = await person();
  await link(actor);
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1",
  ).run();
  const server = discordServer(),
    send: typeof fetch = async (input, init) => {
      const response = await server.send(input, init);
      response.headers.set("X-RateLimit-Remaining", "0");
      response.headers.set("X-RateLimit-Reset-After", "30");
      return response;
    };
  await processDiscordSync(config, send);
  assert.equal(server.state.calls.length, 1); // membership GET persisted before pause
  await due();
  await processDiscordSync(config, server.send);
  assert.deepEqual(server.state.roles, [config.DISCORD_VOLUNTEER_ROLE_ID]);
});

test("an ambiguous role mutation is re-read and converges after eligibility revocation instead of trusting a stale cache", async () => {
  const actor = await person();
  await link(actor);
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1",
  ).run();
  const server = discordServer();
  let failed = false;
  const send: typeof fetch = async (input, init) => {
    const response = await server.send(input, init);
    if (String(input).includes("/roles/") && !failed) {
      failed = true;
      throw new Error("accepted but response lost");
    }
    return response;
  };
  await processDiscordSync(config, send);
  assert.deepEqual(server.state.roles, [config.DISCORD_VOLUNTEER_ROLE_ID]);
  const delayed = await loadDiscordStatus(config, actor.id);
  assert.match(delayed.notice!, /Discord sync is delayed/);
  assert.equal(delayed.notice, delayed.sync);
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=0",
  ).run();
  await due();
  await processDiscordSync(config, server.send);
  assert.deepEqual(server.state.roles, []);
  assert.equal(
    (await loadDiscordStatus(config, actor.id)).sync,
    "Roles synchronized with your current website eligibility",
  );
});

test("leaving never causes an unconsented rejoin and expired join tokens are erased", async () => {
  const actor = await person();
  await link(actor);
  const server = discordServer();
  await processDiscordSync(config, server.send);
  server.state.member = false;
  server.state.calls = [];
  await due();
  await processDiscordSync(config, server.send);
  assert.deepEqual(
    server.state.calls.map(({ method }) => method),
    ["GET"],
  );
  const missing = await loadDiscordStatus(config, actor.id);
  assert.match(missing.connection, /Reconnect/);
  assert.equal(missing.notice, missing.connection);
  assert.equal(discordConnectionIdentity(missing), "Connected as @volunteer");
  assert.equal(missing.needsReconnect, true);
  await link(actor);
  await env.DB.prepare("UPDATE discord_link SET token_expires_at=0").run();
  await due();
  await processDiscordSync(config, server.send);
  assert.equal(
    (await env.DB.prepare("SELECT join_token FROM discord_link").first())
      ?.join_token,
    null,
  );
  assert.equal(server.state.member, false);
});

test("bot permission failures are durable and previews never contact Discord", async () => {
  const actor = await person();
  await link(actor);
  let calls = 0;
  const denied: typeof fetch = async () => {
    calls++;
    return Response.json(
      { message: "private provider detail" },
      { status: 403 },
    );
  };
  await processDiscordSync(config, denied);
  assert.equal(calls, 1);
  const status = await loadDiscordStatus(config, actor.id);
  assert.match(status.sync, /temporarily unavailable/);
  assert.equal(status.notice, status.sync);
  assert.equal(status.needsReconnect, false);
  assert.equal(
    JSON.stringify(status).includes("private provider detail"),
    false,
  );
  await due();
  await processDiscordSync({ ...config, APP_ENV: "preview" }, denied);
  assert.equal(calls, 1);
  await assert.rejects(
    startDiscordLink({ ...config, APP_ENV: "preview" }, actor, origin, {
      userId: actor.id,
      consent: true,
    }),
    statusError(503),
  );
});

test("an expired worker lease recovers work, while an old worker cannot checkpoint or release a new owner's lease", async () => {
  const actor = await person();
  await link(actor);
  await env.DB.prepare(
    "INSERT INTO discord_worker (id,lease_token,lease_until) VALUES (1,'crashed',1)",
  ).run();
  const server = discordServer();
  let stolen = false;
  const send: typeof fetch = async (input, init) => {
    const response = await server.send(input, init);
    if (!stolen) {
      stolen = true;
      await env.DB.prepare(
        "UPDATE discord_worker SET lease_token='new-owner',lease_until=? WHERE id=1",
      )
        .bind(Date.now() + 60_000)
        .run();
    }
    return response;
  };
  await processDiscordSync(config, send);
  assert.equal(
    (await loadApplicationProgress(env.DB, actor.id)).discordCompletedAt,
    null,
  );
  assert.equal(
    await env.DB.prepare("SELECT lease_token FROM discord_worker").first(
      "lease_token",
    ),
    "new-owner",
  );
  assert.equal(server.state.calls.length, 1);
  await env.DB.prepare("UPDATE discord_worker SET lease_until=1").run();
  await processDiscordSync(config, server.send);
  assert.ok(
    (await loadApplicationProgress(env.DB, actor.id)).discordCompletedAt,
  );
});

test("an eligibility change during an accepted role grant cannot be checkpointed as synchronized", async () => {
  const actor = await person();
  await link(actor);
  await env.DB.prepare(
    "UPDATE volunteer_status SET registration_approved=1",
  ).run();
  const server = discordServer();
  let revoked = false;
  const send: typeof fetch = async (input, init) => {
    const response = await server.send(input, init);
    if (String(input).includes("/roles/") && !revoked) {
      revoked = true;
      await env.DB.prepare(
        "UPDATE volunteer_status SET registration_approved=0",
      ).run();
    }
    return response;
  };
  await processDiscordSync(config, send);
  assert.deepEqual(server.state.roles, []);
  assert.equal(
    (await loadDiscordStatus(config, actor.id)).sync,
    "Roles synchronized with your current website eligibility",
  );
});

test("concurrent attempts cannot attach one Discord identity to two website accounts", async () => {
  const alice = await person(),
    bob = await person("bob");
  const outcomes = await Promise.allSettled([link(alice), link(bob)]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    await env.DB.prepare("SELECT count(*) AS n FROM discord_link").first("n"),
    1,
  );
});

test("grandfathered volunteers can opt in without inventing a missing Naloxone completion", async () => {
  const actor = await person();
  await env.DB.prepare("DELETE FROM discord_requirement").run();
  await env.DB.prepare("UPDATE profile SET naloxone_completed_at=NULL").run();
  await startDiscordLink(config, actor, origin, {
    userId: actor.id,
    consent: true,
  });
  await link(actor);
  assert.equal(
    (await loadApplicationProgress(env.DB, actor.id)).naloxoneCompletedAt,
    null,
  );
});
