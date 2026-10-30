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

// Queries using profile alias p and user alias u. Match applicationDisplayName.
export const profileFullNameSql = `trim(coalesce(p.first_name, '') || ' ' ||
  CASE WHEN coalesce(p.middle_names, '') <> '' THEN p.middle_names || ' ' ELSE '' END ||
  coalesce(p.last_name, ''))`;

// Preserve legacy combined answers, falling back to the account display name.
export const profileDisplayNameSql = `coalesce(
  nullif(trim(p.preferred_name), ''), nullif(${profileFullNameSql}, ''),
  u.name
)`;
