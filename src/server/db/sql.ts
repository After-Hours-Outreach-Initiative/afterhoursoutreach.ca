// SQLite's statement-time clock, converted from Julian days to Unix milliseconds.
// 2440587.5 is the Unix epoch in Julian days; 86400000 is milliseconds per day.
// Round away Julian-day floating-point drift so start-boundary comparisons use
// the same integer milliseconds as event timestamps (not a fraction before it).
export const nowMsSql =
  "CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

// Match isApplicationReadyForReview; Discord linking is temporarily disabled.
export const applicationReadyForReviewSql =
  "(p.registered_at IS NOT NULL AND p.naloxone_completed_at IS NOT NULL)";

// Backend-owned aliases only. Null preserves deployed orientation events while
// allowing an explicit override on both standalone and recurring patrols.
export const includesOrientationSql = (alias = "e") =>
  `coalesce(${alias}.includes_orientation, ${alias}.type = 'orientation')`;

// Manual patrol approval determines progression; attendance is historical only.
export const newVolunteerSql = (userId: string) => `NOT EXISTS (
  SELECT 1 FROM volunteer_status nv WHERE nv.user_id = ${userId} AND nv.patrol_approved = 1
)`;

// Use the authoritative approvals and medic team, never orientation attendance.
export const approvedMedicSql = (userId: string) => `EXISTS (
  SELECT 1 FROM profile mp JOIN volunteer_status mv ON mv.user_id = mp.user_id
  WHERE mp.user_id = ${userId} AND mv.registration_approved = 1 AND mv.patrol_approved = 1
    AND EXISTS (SELECT 1 FROM json_each(mp.teams) WHERE value = 'medic')
)`;

// Presentation only: approved applicants who selected the medic team get a plus.
// Unlike approvedMedicSql, this does not grant eligibility or satisfy reservations.
export const medicMarkSql = (userId: string) => `EXISTS (
  SELECT 1 FROM profile mp JOIN volunteer_status mv ON mv.user_id = mp.user_id
  WHERE mp.user_id = ${userId} AND mv.registration_approved = 1
    AND EXISTS (SELECT 1 FROM json_each(mp.teams) WHERE value = 'medic')
)`;

export const attendeeCategorySql = (userId: string) =>
  `CASE WHEN ${newVolunteerSql(userId)} THEN 'new-volunteer'
    WHEN ${approvedMedicSql(userId)} THEN 'medic' ELSE 'outreach-volunteer' END`;

// Keep full names available for directory searches, not standard display.
export const profileFullNameSql = `trim(coalesce(p.first_name, '') || ' ' ||
  CASE WHEN coalesce(p.middle_names, '') <> '' THEN p.middle_names || ' ' ELSE '' END ||
  coalesce(p.last_name, ''))`;

// Match personDisplayName, including JS trim/whitespace and Unicode code points.
const nameWhitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
];
const trimNameSql = (value: string) =>
  `trim(coalesce(${value}, ''), char(${nameWhitespace.join(",")}))`;

/** Backend-owned expressions only. Legacy combined names are a last resort. */
export function personDisplayNameSql({
  firstName = "NULL",
  lastName = "NULL",
  preferredName = "NULL",
  legacyName = "''",
}: {
  firstName?: string;
  lastName?: string;
  preferredName?: string;
  legacyName?: string;
}) {
  const legacyWords = nameWhitespace
    .filter((code) => code !== 32)
    .reduce(
      (sql, code) => `replace(${sql}, char(${code}), ' ')`,
      "display_legacy",
    );
  return `(WITH display_parts AS (
    SELECT coalesce(nullif(${trimNameSql(preferredName)}, ''), ${trimNameSql(firstName)}) AS display_given,
      ${trimNameSql(lastName)} AS display_surname, ${trimNameSql(legacyName)} AS display_legacy
  ), display_words AS (
    SELECT value, key FROM display_parts,
      json_each('[' || replace(json_quote(${legacyWords}), ' ', '","') || ']')
    WHERE value <> ''
  ) SELECT CASE WHEN display_given <> '' OR display_surname <> '' THEN
      display_given || CASE WHEN display_given <> '' AND display_surname <> '' THEN ' ' ELSE '' END ||
      CASE WHEN display_surname <> '' THEN substr(display_surname, 1, 1) || '.' ELSE '' END
    ELSE coalesce((SELECT value FROM display_words ORDER BY key LIMIT 1), '') ||
      CASE WHEN (SELECT count(*) FROM display_words) > 1 THEN
        ' ' || substr((SELECT value FROM display_words ORDER BY key DESC LIMIT 1), 1, 1) || '.'
      ELSE '' END
    END FROM display_parts)`;
}

export const profileDisplayNameSql = personDisplayNameSql({
  firstName: "p.first_name",
  lastName: "p.last_name",
  preferredName: "p.preferred_name",
  legacyName: "u.name",
});
