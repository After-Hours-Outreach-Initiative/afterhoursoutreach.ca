import type { Actor } from "../db/access";
import type { EventRow } from "../db/events";

// Only an opaque view version crosses the stream. The normal page rendering
// still authorizes and supplies event details, signup controls and rosters.
export async function eventViewVersion(
  events: EventRow[],
  actor: Actor | null,
) {
  const view = JSON.stringify({
    events,
    actor: actor && {
      id: actor.id,
      role: actor.role,
      registered: actor.registered,
      active: actor.active,
      patrolApproved: actor.patrolApproved,
      twoFactorEnabled: actor.twoFactorEnabled,
      twoFactorVerified: actor.twoFactorVerified,
    },
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(view),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const interval = 2_000;
const lifetime = 60_000;

export function eventStream(
  initialVersion: string,
  readVersion: () => Promise<string>,
  signal: AbortSignal,
) {
  const stopped = new AbortController();
  const expiresAt = Date.now() + lifetime;
  const encoder = new TextEncoder();
  const frame = (version: string) =>
    encoder.encode(`event: events\ndata: ${JSON.stringify(version)}\n\n`);
  const stop = () => {
    signal.removeEventListener("abort", abort);
    stopped.abort();
  };
  let abort: () => void;

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          stop();
          controller.close();
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        controller.enqueue(encoder.encode(`retry: ${interval}\n\n`));
        controller.enqueue(frame(initialVersion));
      },
      async pull(controller) {
        // Returning this promise ties polling to the response stream's lifetime.
        // Backpressure and cancellation prevent abandoned clients doing D1 work.
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            stopped.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, interval);
          stopped.signal.addEventListener("abort", finish, { once: true });
          if (stopped.signal.aborted) finish();
        });
        if (stopped.signal.aborted) return;
        if (Date.now() >= expiresAt) {
          stop();
          controller.close();
          return;
        }
        try {
          const version = await readVersion();
          if (!stopped.signal.aborted) controller.enqueue(frame(version));
        } catch {
          if (!stopped.signal.aborted) {
            stop();
            console.error(JSON.stringify({ event: "event_stream_failed" }));
            controller.error(new Error("Event updates are unavailable."));
          }
        }
      },
      cancel: stop,
    },
    { highWaterMark: 0 },
  );
}
