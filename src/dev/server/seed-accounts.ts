import {
  localAccountFixtures,
  localAccountUserId,
} from "../../../scripts/local-account-fixtures";
import type { AuthBindings } from "../../server/auth";
import { assertDatabaseReady } from "../../server/db/readiness";
import { RequestError } from "../../server/http";
import { localAuthenticatorCode } from "./authenticator-code";

export async function seedLocalAccounts(
  bindings: AuthBindings,
  testFixtures = false,
) {
  try {
    await assertDatabaseReady(bindings.DB);
  } catch {
    throw new RequestError(
      503,
      "Apply local migrations with pnpm db:migrate:local, then try seeding again.",
    );
  }
  if (!testFixtures)
    await bindings.DB.batch(
      localAccountFixtures().map((sql) => bindings.DB.prepare(sql)),
    );
  // Both targets are fixed fictional fixtures, never a caller-supplied account.
  const organizerId = testFixtures
    ? "local-fixture-user-robin"
    : localAccountUserId("organizer");
  const organizerEmail = testFixtures
    ? "robin.local@example.org"
    : "organizer.v2.local@example.org";
  const organizer = await bindings.DB.prepare(
    "SELECT email, two_factor_enabled AS enabled FROM user WHERE id=?",
  )
    .bind(organizerId)
    .first<{ email: string; enabled: number }>();
  // Preserve changed identities and already-enrolled authenticators on reseeding.
  if (organizer?.email !== organizerEmail || organizer.enabled) return;

  // Use an isolated server-side cookie jar. Never switch the caller's account,
  // return an enrollment secret, or leave a setup session behind.
  const { createAuth } = await import("../../server/auth");
  const auth = createAuth(bindings);
  const cookies = new Map<string, string>();
  const post = async (path: string, body: object) => {
    const response = await auth.handler(
      new Request(`${bindings.AUTH_BASE_URL}/api/v1/auth${path}`, {
        method: "POST",
        headers: {
          origin: bindings.AUTH_BASE_URL,
          "content-type": "application/json",
          cookie: [...cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        },
        body: JSON.stringify(body),
      }),
    );
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RequestError(
        503,
        "Could not finish local organizer setup. Try seeding again.",
      );
    }
    return response.json();
  };
  try {
    await post("/dev/switch-user", { userId: organizerId });
    const setup = (await post("/two-factor/enable", { method: "totp" })) as {
      totpURI: string;
    };
    const key = new URL(setup.totpURI).searchParams.get("secret")!;
    await post("/two-factor/verify-totp", {
      code: localAuthenticatorCode(key),
    });
  } finally {
    if (cookies.size) await post("/sign-out", {});
  }
}

/** Empty every app table, keeping applied migrations. */
export async function clearLocalData(db: AuthBindings["DB"]) {
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
      AND name <> 'd1_migrations'`,
    )
    .all<{ name: string }>();
  // Triggers guard real data, such as keeping the last organizer or never
  // deleting a recurring date. Lift them while emptying, then restore them.
  const triggers = await db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL",
    )
    .all<{ name: string; sql: string }>();
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  // One transaction, so a failure leaves everything as it was. Foreign keys
  // are checked only once every table is empty.
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...triggers.results.map(({ name }) =>
      db.prepare(`DROP TRIGGER ${quote(name)}`),
    ),
    ...tables.results.map(({ name }) =>
      db.prepare(`DELETE FROM ${quote(name)}`),
    ),
    ...triggers.results.map(({ sql }) => db.prepare(sql)),
  ]);
}

/** Empty the local database, then seed it as `pnpm dev` does. Everything
 * else, including accounts and events made by hand, is removed. */
export async function resetLocalData(bindings: AuthBindings) {
  try {
    await assertDatabaseReady(bindings.DB);
  } catch {
    throw new RequestError(
      503,
      "Apply local migrations with pnpm db:migrate:local, then try again.",
    );
  }
  await clearLocalData(bindings.DB);
  await seedLocalAccounts(bindings);
}
