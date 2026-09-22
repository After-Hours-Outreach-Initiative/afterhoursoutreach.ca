// Browser-side stand-in for the server this feature would really need. All
// state lives in one localStorage key: the patrols, everyone signed up, the
// accounts, and an outbox holding the emails that would have been sent.
// Nothing leaves the browser and nothing is sent anywhere.

import {
  formatPatrolDate,
  organizerEmails,
  seedAccounts,
  seedPatrols,
  seedSignups,
  seedVersion,
  signInMinutes,
  signInWindow,
  type Patrol,
  type Signup,
} from "@/data/patrols";

export interface Email {
  id: string;
  to: string;
  subject: string;
  body: string;
  links: { label: string; href: string }[];
  sentAt: number;
}

interface Account {
  name: string;
}

interface MagicLink {
  token: string;
  /** Six digits, for signing in on the device that asked rather than the one
   * holding the inbox. Same lifetime and same single use as the link. */
  code: string;
  email: string;
  expiresAt: number;
  /** A six digit code is guessable, so a run of misses kills it. */
  attempts: number;
}

interface State {
  version: number;
  patrols: Patrol[];
  signups: Signup[];
  outbox: Email[];
  /** Email address of whoever is signed in on this device. */
  session: string | null;
  accounts: Record<string, Account>;
  magicLinks: MagicLink[];
}

const KEY = "ahoi.patrol-mockup";

const freshState = (): State => ({
  version: seedVersion,
  patrols: structuredClone(seedPatrols),
  signups: structuredClone(seedSignups),
  outbox: [],
  session: null,
  accounts: structuredClone(seedAccounts),
  magicLinks: [],
});

let state: State = freshState();
const listeners = new Set<() => void>();

const read = (): State => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as State;
    if (parsed.version !== seedVersion) return freshState();
    return parsed;
  } catch {
    return freshState();
  }
};

const write = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private browsing and full quotas both land here. The mockup still works
    // for the length of the page view.
  }
  listeners.forEach((listener) => listener());
};

export const load = () => {
  state = read();
};

export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// Another tab changed the same key.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    state = read();
    listeners.forEach((listener) => listener());
  });
}

const token = () => Math.random().toString(36).slice(2, 10);

/**
 * Signing in, and taking or giving up a spot, are round trips to a server in
 * the real thing, so the mockup waits about as long before anything changes.
 */
const roundTrip = () =>
  new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 400));

const sixDigits = () => String(Math.floor(100_000 + Math.random() * 900_000));

const maxAttempts = 10;

export const patrols = () =>
  [...state.patrols].sort((a, b) => a.date.localeCompare(b.date));

export const patrol = (id: string) =>
  state.patrols.find((item) => item.id === id);

export const signupsFor = (patrolId: string, status?: Signup["status"]) =>
  state.signups
    .filter((signup) => signup.patrolId === patrolId)
    .filter((signup) => (status ? signup.status === status : true))
    .sort((a, b) => a.createdAt - b.createdAt);

export interface Counts {
  spots: number;
  confirmed: number;
  spotsLeft: number;
  full: boolean;
}

export const counts = (patrolId: string): Counts => {
  const spots = patrol(patrolId)?.spots ?? 0;
  const confirmed = signupsFor(patrolId, "confirmed").length;
  const spotsLeft = Math.max(0, spots - confirmed);
  return { spots, confirmed, spotsLeft, full: spotsLeft === 0 };
};

export const outbox = () =>
  [...state.outbox].sort((a, b) => b.sentAt - a.sentAt);

const send = (email: Omit<Email, "id" | "sentAt">) => {
  state.outbox.push({ ...email, id: token(), sentAt: Date.now() });
};

const patrolLabel = (patrolId: string) => {
  const found = patrol(patrolId);
  return found ? formatPatrolDate(found.date) : patrolId;
};

// Signing in ---------------------------------------------------------------

export interface Session {
  email: string;
  name: string;
}

/** Whoever is signed in here, or null. A session with no name yet is fine. */
export const session = (): Session | null => {
  if (!state.session) return null;
  return {
    email: state.session,
    name: state.accounts[state.session]?.name ?? "",
  };
};

/**
 * Mails a one time sign in link back to the page the person is on. The token
 * is the whole credential, which is the point of a magic link.
 */
export const requestSignIn = async (email: string, returnHref: string) => {
  await roundTrip();
  const address = email.trim().toLowerCase();
  const link: MagicLink = {
    token: token(),
    code: sixDigits(),
    email: address,
    expiresAt: Date.now() + signInMinutes * 60_000,
    attempts: 0,
  };
  state.magicLinks.push(link);

  const separator = returnHref.includes("?") ? "&" : "?";
  const href = `${returnHref}${separator}signin=${link.token}`;
  send({
    to: address,
    subject: `Your sign in code is ${link.code}`,
    body: `${
      state.accounts[address]
        ? "Welcome back."
        : "This signs you in and makes your account."
    } Open the link, or type the code ${link.code} on the page you started from. Both stop working after ${signInWindow}.`,
    links: [{ label: "Sign me in", href }],
  });
  write();
  return { email: address, href, code: link.code };
};

export type SignInResult =
  { ok: true; needsName: boolean } | { ok: false; error: string };

const accept = (link: MagicLink): SignInResult => {
  // One use only, whichever way it was used.
  state.magicLinks = state.magicLinks.filter((item) => item !== link);
  state.session = link.email;
  write();
  return { ok: true, needsName: !state.accounts[link.email] };
};

export const completeSignIn = (value: string): SignInResult => {
  const link = state.magicLinks.find((item) => item.token === value);
  if (!link)
    return { ok: false, error: "That sign in link is not valid any more." };
  if (link.expiresAt <= Date.now()) {
    state.magicLinks = state.magicLinks.filter((item) => item !== link);
    write();
    return { ok: false, error: "That sign in link has expired." };
  }
  return accept(link);
};

/** The other way in: the code typed on the device that asked for it. */
export const completeSignInWithCode = async (
  email: string,
  value: string,
): Promise<SignInResult> => {
  await roundTrip();
  const address = email.trim().toLowerCase();
  const digits = value.replace(/\D/g, "");
  const link = state.magicLinks.find(
    (item) => item.email === address && item.expiresAt > Date.now(),
  );
  if (!link)
    return { ok: false, error: "That code has expired. Ask for a new one." };

  if (link.code !== digits) {
    link.attempts += 1;
    const spent = link.attempts >= maxAttempts;
    if (spent) state.magicLinks = state.magicLinks.filter((i) => i !== link);
    write();
    return {
      ok: false,
      error: spent
        ? "Too many wrong codes. Ask for a new one."
        : "That code is not right.",
    };
  }

  return accept(link);
};

export const setName = (name: string) => {
  if (!state.session) return;
  state.accounts[state.session] = { name: name.trim() };
  // Older signups under this address catch up with the new name.
  state.signups
    .filter((signup) => signup.email === state.session)
    .forEach((signup) => (signup.name = name.trim()));
  write();
};

/**
 * Mockup only. The view switcher drops straight into a session, skipping the
 * email round trip that a real sign in goes through.
 */
export const signInAs = (email: string, name: string) => {
  const address = email.trim().toLowerCase();
  state.session = address;
  state.accounts[address] ??= { name };
  write();
};

export const signOut = () => {
  state.session = null;
  write();
};

// Taking and giving up spots -----------------------------------------------

/** Where the signed in person stands on a patrol. */
export const mySignup = (patrolId: string) => {
  if (!state.session) return undefined;
  return state.signups.find(
    (signup) =>
      signup.patrolId === patrolId &&
      signup.email === state.session &&
      signup.status !== "cancelled",
  );
};

export type SignupResult = { ok: true } | { ok: false; error: string };

export const signUp = async (patrolId: string): Promise<SignupResult> => {
  await roundTrip();
  const me = session();
  if (!me) return { ok: false, error: "Sign in first." };
  if (!me.name) return { ok: false, error: "Tell us your name first." };

  const target = patrol(patrolId);
  if (!target) return { ok: false, error: "That patrol no longer exists." };
  if (!target.open)
    return { ok: false, error: "This patrol is closed to new signups." };
  if (mySignup(patrolId))
    return { ok: false, error: "You are already signed up for this patrol." };

  if (counts(patrolId).full)
    return { ok: false, error: "This patrol is full." };

  state.signups.push({
    id: token(),
    patrolId,
    name: me.name,
    email: me.email,
    status: "confirmed",
    createdAt: Date.now(),
  });

  send({
    to: me.email,
    subject: `You are on the ${patrolLabel(patrolId)} patrol`,
    body: `${target.startTime} at ${target.meetingPoint}. Cancel from the patrol list if you cannot make it.`,
    links: [],
  });
  write();
  return { ok: true };
};

export const cancelSignup = async (id: string) => {
  await roundTrip();
  const signup = state.signups.find((item) => item.id === id);
  if (!signup || signup.status === "cancelled") return;
  signup.status = "cancelled";
  write();
};

// Organizers ---------------------------------------------------------------

/**
 * Organizers are ordinary signed in people whose address is on the list. They
 * get extra controls on the same patrol list, not a separate area.
 */
export const isOrganizer = () =>
  Boolean(state.session && organizerEmails.includes(state.session));

export const savePatrol = (next: Patrol) => {
  const index = state.patrols.findIndex((item) => item.id === next.id);
  if (index === -1) state.patrols.push(next);
  else state.patrols[index] = next;
  write();
};

export const deletePatrol = (id: string) => {
  state.patrols = state.patrols.filter((item) => item.id !== id);
  state.signups = state.signups.filter((signup) => signup.patrolId !== id);
  write();
};

export const resetAll = () => {
  state = freshState();
  write();
};
