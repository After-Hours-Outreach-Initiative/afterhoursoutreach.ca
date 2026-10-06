// SQLite's statement-time clock, converted from Julian days to Unix milliseconds.
// 2440587.5 is the Unix epoch in Julian days; 86400000 is milliseconds per day.
export const nowMsSql = "(julianday('now') - 2440587.5) * 86400000";
