/**
 * Persist the result of consent and verified membership in an isolated test DB.
 * OAuth/provider verification is covered separately; this fixture never removes
 * the Discord requirement, confirms Naloxone completion, or grants approval.
 */
export async function seedVerifiedDiscordMembership(
  db: Env["DB"],
  userId: string,
  completedAt = Date.now(),
) {
  await db
    .prepare(
      `INSERT INTO discord_link
      (user_id,discord_id,username,guild_id,consented_at,completed_at,
       member_verified_at,member_ready,checked_at,next_attempt_at)
     VALUES (?,?,'Verified test member','test-only-guild',?,?,?,1,?,0)`,
    )
    .bind(
      userId,
      `test-discord-${userId}`,
      completedAt,
      completedAt,
      completedAt,
      completedAt,
    )
    .run();
}
