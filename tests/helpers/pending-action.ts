import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
const actionPaths = new Set([
  "/api/v1/events/action",
  "/api/v1/organizer/action",
]);

/** Changes that email wait for an undo timer. Tests that are not about the
 * timer make them straight away, as an organizer's "<Verb> now" button does,
 * and get the made change's response, or its failure as a 409. */
export async function makeWaitingChange<
  T extends {
    ok: boolean;
    status: number;
    clone(): { json(): Promise<unknown> };
  },
>(
  path: string,
  response: T,
  send: (path: string, body: object) => Promise<T>,
): Promise<T> {
  if (!actionPaths.has(path) || !response.ok) return response;
  const body = (await response.clone().json()) as {
    pendingAction?: { id: string };
  };
  if (!body.pendingAction) return response;
  const run = await send("/api/v1/pending-actions", {
    action: "run",
    id: body.pendingAction.id,
  });
  const result = (await run.clone().json()) as {
    status?: string;
    message?: string;
  };
  if (result.status !== "failed") return run;
  // The caller handles the failure, so it needs no toast.
  await send("/api/v1/pending-actions", {
    action: "dismiss",
    id: body.pendingAction.id,
  });
  return Response.json(
    { message: result.message },
    { status: 409 },
  ) as unknown as T;
}

/** Press a waiting change's "<Verb> now" button on the changed item's
 * banner, which makes it now. Toasts only link to the banner. */
export async function makeWaitingChangeNow(page: Page, verb: string) {
  await page
    .locator("[data-pending-inline]")
    .getByRole("button", { name: `${verb} now`, exact: true })
    .first()
    .click();
}

/** makeWaitingChange for Playwright request contexts. */
export async function makeWaitingRequest(
  request: APIRequestContext,
  origin: string,
  response: APIResponse,
): Promise<APIResponse> {
  if (!response.ok()) return response;
  const body = (await response.json()) as { pendingAction?: { id: string } };
  if (!body.pendingAction) return response;
  return request.post("/api/v1/pending-actions", {
    headers: { origin },
    data: { action: "run", id: body.pendingAction.id },
  });
}
