import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { DashboardError } from "./cloudflare";
import type { PreparedPlan } from "./application";
import type { AuditEntry } from "./types";

export const apiPrefix = "/__docs/dashboard/";
const addresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const hosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const cookieName = "aho_docs_dashboard";
export interface Session {
  csrf: string;
  touchedAt: number;
  createdAt: number;
  unlocks: Map<string, number>;
  plans: Map<string, PreparedPlan>;
  busy: boolean;
}

export function secureHeaders(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

export function localRequest(req: IncomingMessage) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (
    !addresses.has(req.socket.remoteAddress ?? "") ||
    !hosts.has(url.hostname) ||
    Number(url.port || 80) !== req.socket.localPort ||
    (req.headers.origin && req.headers.origin !== url.origin) ||
    (req.headers["sec-fetch-site"] &&
      !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))
  )
    throw new DashboardError(
      403,
      "local_only",
      "The dashboard is available only from this local docs server, not other sites or network hosts.",
    );
  if (req.method !== "GET" && req.headers.origin !== url.origin)
    throw new DashboardError(
      403,
      "same_origin_required",
      "Changes must originate from this docs page.",
    );
  return url;
}

export function respond(res: ServerResponse, status: number, value: unknown) {
  secureHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

export async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new DashboardError(
      415,
      "json_required",
      "Send administrative actions as JSON.",
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16_384)
      throw new DashboardError(
        413,
        "request_too_large",
        "The dashboard request is too large.",
      );
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new DashboardError(
      400,
      "invalid_json",
      "The dashboard request is not a JSON object.",
    );
  }
}

export class Sessions {
  private sessions = new Map<string, Session>();
  get(req: IncomingMessage, res: ServerResponse, create = false) {
    for (const [key, session] of this.sessions) {
      if (
        session.touchedAt < Date.now() - 30 * 60_000 ||
        session.createdAt < Date.now() - 8 * 60 * 60_000
      )
        this.sessions.delete(key);
    }
    const id =
      req.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1) ?? "";
    let session = this.sessions.get(id);
    if (!session && create) {
      if (this.sessions.size >= 32)
        throw new DashboardError(
          429,
          "session_limit",
          "Too many local dashboard sessions. Restart the docs server to clear them.",
        );
      session = {
        csrf: randomBytes(32).toString("hex"),
        touchedAt: Date.now(),
        createdAt: Date.now(),
        unlocks: new Map(),
        plans: new Map(),
        busy: false,
      };
      const nextId = randomBytes(32).toString("hex");
      this.sessions.set(nextId, session);
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${nextId}; HttpOnly; SameSite=Strict; Path=${apiPrefix}`,
      );
    }
    if (!session)
      throw new DashboardError(
        401,
        "session_expired",
        "The local dashboard session expired. Reload the page to reconnect.",
      );
    session.touchedAt = Date.now();
    if (!create) {
      const supplied = req.headers["x-dashboard-csrf"];
      if (
        typeof supplied !== "string" ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        supplied.length !== session.csrf.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf))
      )
        throw new DashboardError(
          403,
          "csrf_required",
          "Reload the dashboard before accessing administrative data.",
        );
    }
    return session;
  }
}

export class ActivityLog {
  readonly path: string;
  private operator = userInfo().username;
  constructor(root: string) {
    this.path = join(root, ".wrangler", "docs-dashboard", "activity.jsonl");
  }
  async append(
    entry: Omit<AuditEntry, "id" | "time" | "operator">,
    id = randomUUID(),
  ) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const value: AuditEntry = {
      id,
      time: new Date().toISOString(),
      operator: this.operator,
      ...entry,
    };
    await appendFile(this.path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
    return id;
  }
  async recent(database?: string) {
    let file;
    try {
      file = await open(this.path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      if (start) lines.shift();
      return lines
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AuditEntry];
          } catch {
            return [];
          }
        })
        .filter((entry) => !database || entry.database === database)
        .slice(-100)
        .reverse();
    } finally {
      await file.close();
    }
  }
}
