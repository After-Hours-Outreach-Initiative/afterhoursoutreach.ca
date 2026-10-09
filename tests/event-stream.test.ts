import { afterEach, expect, test, vi } from "vitest";
import type { Actor } from "../src/server/db/access";
import type { EventRow } from "../src/server/db/events";
import { eventStream, eventViewVersion } from "../src/server/events/stream";

const event: EventRow = {
  id: "event",
  type: "orientation",
  startsAt: 2_000_000_000_000,
  meetingPoint: "Meeting point",
  meetingPointUrl: null,
  spots: 1,
  open: 1,
  hidden: 0,
  cancelledAt: null,
  updatedAt: 1,
  confirmed: 0,
  signedUp: 0,
};
const actor: Actor = {
  id: "volunteer",
  name: "Volunteer",
  sessionId: "session",
  role: "volunteer",
  registered: true,
  active: true,
  patrolApproved: false,
  twoFactorEnabled: false,
  twoFactorVerified: false,
};
const decode = (value: Uint8Array | undefined) =>
  new TextDecoder().decode(value);

afterEach(() => vi.useRealTimers());

test("view versions detect capacity, signups, visibility and access changes without sending details", async () => {
  const original = await eventViewVersion([event], actor);
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  expect(await eventViewVersion([event], actor)).toBe(original);
  for (const update of [
    { confirmed: 1 },
    { signedUp: 1 },
    { spots: 2 },
    { open: 0 },
    { hidden: 1 },
    { cancelledAt: 1 },
  ])
    expect(await eventViewVersion([{ ...event, ...update }], actor)).not.toBe(
      original,
    );
  expect(await eventViewVersion([], actor)).not.toBe(original);
  expect(await eventViewVersion([event], null)).not.toBe(original);
  expect(await eventViewVersion([event], { ...actor, active: false })).not.toBe(
    original,
  );
  expect(
    await eventViewVersion([event], { ...actor, sessionId: "renewed" }),
  ).toBe(original);
});

test("SSE supplies an initial snapshot, periodic versions and a reconnect delay", async () => {
  vi.useFakeTimers();
  const readVersion = vi.fn().mockResolvedValue("updated");
  const reader = eventStream(
    "initial",
    readVersion,
    new AbortController().signal,
  ).getReader();
  try {
    expect(decode((await reader.read()).value)).toBe("retry: 2000\n\n");
    expect(decode((await reader.read()).value)).toBe(
      'event: events\ndata: "initial"\n\n',
    );
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(decode((await next).value)).toBe(
      'event: events\ndata: "updated"\n\n',
    );
    expect(readVersion).toHaveBeenCalledTimes(1);
    // Even unchanged versions are heartbeats, and allow a failed page refresh
    // to retry without requiring another signup to happen.
    const heartbeat = reader.read();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(decode((await heartbeat).value)).toContain('data: "updated"');
  } finally {
    await reader.cancel();
  }
});

test("backpressure and client cancellation stop database polling and clear timers", async () => {
  vi.useFakeTimers();
  const readVersion = vi.fn().mockResolvedValue("updated");
  const reader = eventStream(
    "initial",
    readVersion,
    new AbortController().signal,
  ).getReader();
  await reader.read();
  await reader.read();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(readVersion).not.toHaveBeenCalled();
  const pending = reader.read();
  await reader.cancel();
  expect((await pending).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(readVersion).not.toHaveBeenCalled();
});

test("request abort closes the stream even during an in-flight query", async () => {
  vi.useFakeTimers();
  const signal = new AbortController();
  let release!: (version: string) => void;
  const readVersion = vi.fn(
    () => new Promise<string>((resolve) => (release = resolve)),
  );
  const reader = eventStream("initial", readVersion, signal.signal).getReader();
  await reader.read();
  await reader.read();
  const pending = reader.read();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(readVersion).toHaveBeenCalledTimes(1);
  signal.abort();
  expect((await pending).done).toBe(true);
  release("updated");
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await reader.read()).done).toBe(true);
  expect(readVersion).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("connections rotate after one minute so EventSource can reconnect", async () => {
  vi.useFakeTimers();
  const readVersion = vi.fn().mockResolvedValue("updated");
  const reader = eventStream(
    "initial",
    readVersion,
    new AbortController().signal,
  ).getReader();
  await reader.read();
  await reader.read();
  await vi.advanceTimersByTimeAsync(60_000);
  const pending = reader.read();
  await vi.advanceTimersByTimeAsync(2_000);
  expect((await pending).done).toBe(true);
  expect(readVersion).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("query failures end the stream without leaking the database error", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const reader = eventStream(
    "initial",
    async () => {
      throw new Error("private database contents");
    },
    new AbortController().signal,
  ).getReader();
  try {
    await reader.read();
    await reader.read();
    const failed = expect(reader.read()).rejects.toThrow(
      "Event updates are unavailable.",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await failed;
    expect(log).toHaveBeenCalledWith('{"event":"event_stream_failed"}');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    log.mockRestore();
  }
});
