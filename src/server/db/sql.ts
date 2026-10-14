// SQLite's statement-time clock, converted from Julian days to Unix milliseconds.
// 2440587.5 is the Unix epoch in Julian days; 86400000 is milliseconds per day.
export const nowMsSql = "(julianday('now') - 2440587.5) * 86400000";

// Queries using profile alias p and user alias u. Match applicationDisplayName.
export const profileFullNameSql = `trim(coalesce(p.first_name, '') || ' ' ||
  CASE WHEN coalesce(p.middle_names, '') <> '' THEN p.middle_names || ' ' ELSE '' END ||
  coalesce(p.last_name, ''))`;

// Preserve legacy combined answers, falling back to the account display name.
export const profileDisplayNameSql = `coalesce(
  nullif(trim(p.preferred_name), ''), nullif(${profileFullNameSql}, ''),
  u.name
)`;
