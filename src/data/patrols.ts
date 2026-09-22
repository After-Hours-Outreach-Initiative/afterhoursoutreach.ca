// Mockup data for patrol scheduling. Nothing here is real: the patrols, the
// people signed up and the organizer addresses are all made up so the signup
// and organizer screens have something to show. Live state lives in the
// browser, see src/scripts/patrol-store.ts.

export interface Patrol {
  id: string;
  /** Plain calendar date, YYYY-MM-DD. */
  date: string;
  /** 24 hour local time, HH:MM. Patrols carry a start only. */
  startTime: string;
  meetingPoint: string;
  /** Optional map link, shown on the meeting point. */
  meetingPointUrl?: string;
  spots: number;
  /** False closes the patrol to new signups without deleting it. */
  open: boolean;
}

export type SignupStatus = "confirmed" | "cancelled";

export interface Signup {
  id: string;
  patrolId: string;
  name: string;
  email: string;
  status: SignupStatus;
  createdAt: number;
}

/** Bump this when the seed changes so stored state is thrown away. */
export const seedVersion = 7;

/** How long a sign in link and its code stay good, in minutes. */
export const signInMinutes = 60;

/** The same window, worded for the email. */
export const signInWindow =
  signInMinutes % 60 === 0
    ? `${signInMinutes / 60} hour${signInMinutes === 60 ? "" : "s"}`
    : `${signInMinutes} minutes`;

/** Signing in with one of these gets the organizer controls. Not a security
 * boundary: the list ships in the client bundle. */
export const organizerEmails = [
  "info@afterhoursoutreach.ca",
  "scheduling@afterhoursoutreach.ca",
];

/** Every patrol meets in the same place for now. */
const meetingPoint = {
  name: "Lord Strathcona Elementary School",
  url: "https://maps.app.goo.gl/y4huzDbXZ7eDmgiv5",
};

/** Mockup only: the people the view switcher drops you into. */
export const demoUsers = {
  volunteer: { email: "dana.whitfield@example.com", name: "Dana Whitfield" },
  organizer: { email: organizerEmails[0], name: "Robin Vance" },
};

export const seedPatrols: Patrol[] = [
  {
    id: "2026-09-22",
    date: "2026-09-22",
    startTime: "20:30",
    meetingPoint: meetingPoint.name,
    meetingPointUrl: meetingPoint.url,
    spots: 8,
    open: true,
  },
  {
    id: "2026-10-13",
    date: "2026-10-13",
    startTime: "20:30",
    meetingPoint: meetingPoint.name,
    meetingPointUrl: meetingPoint.url,
    spots: 6,
    open: true,
  },
  {
    id: "2026-10-27",
    date: "2026-10-27",
    startTime: "20:30",
    meetingPoint: meetingPoint.name,
    meetingPointUrl: meetingPoint.url,
    spots: 8,
    open: true,
  },
  {
    id: "2026-11-10",
    date: "2026-11-10",
    startTime: "20:30",
    meetingPoint: meetingPoint.name,
    meetingPointUrl: meetingPoint.url,
    spots: 8,
    open: false,
  },
];

// Seeded people, so the list has a partly full patrol and a full one to look
// at.
const seeded: [string, string, SignupStatus][] = [
  ["2026-09-22", "Dana Whitfield", "confirmed"],
  ["2026-09-22", "Priya Raman", "confirmed"],
  ["2026-09-22", "Marcus Bell", "confirmed"],
  ["2026-09-22", "Joanne Leclair", "confirmed"],
  ["2026-09-22", "Sam Oyelaran", "confirmed"],
  ["2026-10-13", "Alex Nakamura", "confirmed"],
  ["2026-10-13", "Rosa Delgado", "confirmed"],
  ["2026-10-13", "Tay Brooks", "confirmed"],
  ["2026-10-13", "Ines Kowalski", "confirmed"],
  ["2026-10-13", "Gord Feeney", "confirmed"],
  ["2026-10-13", "Nadia Haddad", "confirmed"],
  ["2026-10-27", "Dana Whitfield", "confirmed"],
];

const emailFor = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

export const seedSignups: Signup[] = seeded.map(
  ([patrolId, name, status], index) => ({
    id: `seed-${index + 1}`,
    patrolId,
    name,
    email: emailFor(name),
    status,
    // Spread over the last few days so the roster reads like people signed up
    // recently.
    createdAt: Date.now() - (seeded.length - index) * 8 * 3600_000,
  }),
);

/** Everyone in the seed already has an account, so you can sign in as them. */
export const seedAccounts: Record<string, { name: string }> =
  Object.fromEntries(
    seedSignups.map((signup) => [signup.email, { name: signup.name }]),
  );

/** Local date at noon, so formatting never slides into the day before. */
const asDate = (date: string) => new Date(`${date}T12:00:00`);

export const weekdayOf = (date: string) =>
  asDate(date).toLocaleDateString("en-CA", { weekday: "short" });

export const formatPatrolDate = (date: string) =>
  asDate(date).toLocaleDateString("en-CA", { month: "short", day: "numeric" });

const formatTime = (time: string) => {
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
};

export const formatStartTime = (patrol: Pick<Patrol, "startTime">) =>
  formatTime(patrol.startTime);

/**
 * How the spots left on a patrol read. The colour carries the same thing the
 * words do, so a full patrol is visible before anyone reads the count.
 */
export const spotsState = (spotsLeft: number) => {
  if (spotsLeft === 0) return { label: "Full", tone: "text-red-400" };
  if (spotsLeft <= 2)
    return { label: `${spotsLeft} left`, tone: "text-amber-400" };
  return { label: `${spotsLeft} left`, tone: "text-green-400" };
};

/** Patrols still to come, soonest first. */
export const upcoming = (patrols: Patrol[], now = new Date()) => {
  const today = now.toISOString().slice(0, 10);
  return patrols
    .filter((patrol) => patrol.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
};

/** Counts from the seed alone, for the markup rendered before any script runs. */
export const seedCounts = (patrolId: string) => {
  const patrol = seedPatrols.find((item) => item.id === patrolId);
  const spots = patrol?.spots ?? 0;
  const mine = seedSignups.filter((signup) => signup.patrolId === patrolId);
  const confirmed = mine.filter(
    (signup) => signup.status === "confirmed",
  ).length;
  return {
    spots,
    confirmed,
    spotsLeft: Math.max(0, spots - confirmed),
  };
};
