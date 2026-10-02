import { createDatabase } from "../db";
import { emailChallenge } from "../db/schema";
import { safeReturnTo } from "../http";
import { hashAuthValue } from "./abuse";

function generateCode() {
  const bytes = new Uint32Array(1);
  // Rejection sampling avoids bias when reducing a random integer to 6 digits.
  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0] >= 4_294_000_000);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
}

export async function createEmailChallenge(
  binding: Env["DB"],
  secret: string | undefined,
  email: string,
  returnTo?: string,
  now = Date.now(),
) {
  const id = crypto.randomUUID();
  const code = generateCode();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const [codeHash, tokenHash] = await Promise.all([
    hashAuthValue(secret, `code:${id}:${code}`),
    hashAuthValue(secret, `token:${id}:${token}`),
  ]);
  await createDatabase(binding)
    .insert(emailChallenge)
    .values({
      id,
      email: email.trim().toLowerCase(),
      codeHash,
      tokenHash,
      returnTo: safeReturnTo(returnTo),
      createdAt: new Date(now),
      expiresAt: new Date(now + 3_600_000),
    });
  return { id, code, token };
}

export async function consumeEmailChallenge(
  binding: Env["DB"],
  secret: string | undefined,
  id: string,
  proof: { code: string } | { token: string },
  now = Date.now(),
) {
  const isCode = "code" in proof;
  const hash = await hashAuthValue(
    secret,
    isCode ? `code:${id}:${proof.code}` : `token:${id}:${proof.token}`,
  );
  // Matching, attempt counting, and consumption happen in one statement. A link
  // and its code cannot both create sessions, even when redeemed concurrently.
  const query = isCode
    ? `UPDATE email_challenge
       SET attempts = attempts + 1,
           consumed_at = CASE WHEN code_hash = ? OR attempts + 1 >= 10 THEN ? ELSE NULL END
       WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < 10
       RETURNING email, return_to, code_hash = ? AS valid`
    : `UPDATE email_challenge SET consumed_at = ?
       WHERE id = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < 10
       RETURNING email, return_to, 1 AS valid`;
  const statement = binding.prepare(query);
  const row = await (
    isCode
      ? statement.bind(hash, now, id, now, hash)
      : statement.bind(now, id, hash, now)
  ).first<{ email: string; return_to: string; valid: number }>();
  return row?.valid === 1
    ? { email: row.email, returnTo: row.return_to }
    : null;
}
