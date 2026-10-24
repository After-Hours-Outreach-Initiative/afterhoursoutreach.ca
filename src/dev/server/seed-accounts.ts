import {
  localAccountFixtures,
  localAccountUserId,
} from "../../../scripts/local-account-fixtures";
import type { AuthBindings } from "../../server/auth";
import { assertDatabaseReady } from "../../server/db/readiness";
import { RequestError } from "../../server/http";
import { localAuthenticatorCode } from "./authenticator-code";

export async function seedLocalAccounts(bindings: AuthBindings) {
  try {
    await assertDatabaseReady(bindings.DB);
  } catch {
    throw new RequestError(
      503,
      "Apply local migrations with pnpm db:migrate:local, then try seeding again.",
    );
  }
  await bindings.DB.batch(
    localAccountFixtures().map((sql) => bindings.DB.prepare(sql)),
  );
  const organizerId = localAccountUserId("organizer");
  const organizer = await bindings.DB.prepare(
    "SELECT email, two_factor_enabled AS enabled FROM user WHERE id=?",
  )
    .bind(organizerId)
    .first<{ email: string; enabled: number }>();
  // Preserve changed identities and already-enrolled authenticators on reseeding.
  if (organizer?.email !== "organizer.local@example.org" || organizer.enabled)
    return;

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
