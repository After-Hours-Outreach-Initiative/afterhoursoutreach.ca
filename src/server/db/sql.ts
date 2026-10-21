// SQLite's statement-time clock, converted from Julian days to Unix milliseconds.
// 2440587.5 is the Unix epoch in Julian days; 86400000 is milliseconds per day.
// Round away Julian-day floating-point drift so start-boundary comparisons use
// the same integer milliseconds as event timestamps (not a fraction before it).
export const nowMsSql =
  "CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

// Backend-owned aliases only. Null preserves deployed orientation events while
// allowing an explicit override on both standalone and recurring patrols.
export const includesOrientationSql = (alias = "e") =>
  `coalesce(${alias}.includes_orientation, ${alias}.type = 'orientation')`;

// Queries using profile alias p and user alias u. Match applicationDisplayName.
export const profileFullNameSql = `trim(coalesce(p.first_name, '') || ' ' ||
  CASE WHEN coalesce(p.middle_names, '') <> '' THEN p.middle_names || ' ' ELSE '' END ||
  coalesce(p.last_name, ''))`;

// Preserve legacy combined answers, falling back to the account display name.
export const profileDisplayNameSql = `coalesce(
  nullif(trim(p.preferred_name), ''), nullif(${profileFullNameSql}, ''),
  u.name
)`;
