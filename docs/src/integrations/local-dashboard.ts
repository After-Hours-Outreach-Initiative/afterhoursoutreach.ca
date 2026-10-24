import type { AstroIntegration } from "astro";
import { resolve } from "node:path";
import {
  Application,
  missingApplicationSchema,
} from "../dashboard/application";
import {
  Cloudflare,
  dashboardEnvironment,
  DashboardError,
} from "../dashboard/cloudflare";
import {
  ActivityLog,
  apiPrefix,
  localRequest,
  readJson,
  respond,
  secureHeaders,
  Sessions,
} from "../dashboard/security";
import type { ActionInput, Plan } from "../dashboard/types";

export default function localDashboard(): AstroIntegration {
  return {
    name: "local-operations-dashboard",
    hooks: {
      // Neither production builds nor astro preview register privileged endpoints.
      "astro:server:setup": async ({ server, logger }) => {
        // This hook receives Vite's resolved config: root is a filesystem path,
        // not the URL used by Astro's configuration hooks.
        const docsRoot = server.config.root;
        const root = resolve(docsRoot, "..");
        const cf = new Cloudflare(root, await dashboardEnvironment(docsRoot));
        const app = new Application(cf);
        const sessions = new Sessions();
        const log = new ActivityLog(root);
        const writing = new Set<string>();
        let resendCache: { expires: number; value: unknown } | undefined;
        const metricCache = new Map<
          string,
          { expires: number; value: unknown }
        >();
        const unlocked = (session: ReturnType<Sessions["get"]>, id: string) =>
          session.unlocks.get(id) ?? 0;
        const publicPlan = (plan: Plan): Plan => ({
          token: plan.token,
          title: plan.title,
          details: plan.details,
          impact: plan.impact,
          confirmation: plan.confirmation,
          blocked: plan.blocked,
          expiresAt: plan.expiresAt,
        });
        const review = (plan: Plan) =>
          JSON.stringify({
            title: plan.title,
            details: plan.details,
            impact: plan.impact,
            blocked: plan.blocked,
          });

        server.middlewares.use(async (req, res, next) => {
          const pathname = req.url?.split("?")[0];
          if (pathname === "/dashboard" || pathname === "/dashboard/") {
            secureHeaders(res);
            try {
              localRequest(req);
            } catch {
              res.statusCode = 403;
              res.end("This dashboard is local-only.");
              return;
            }
          }
          if (!pathname?.startsWith(apiPrefix)) return next();
          let databaseId = "";
          let action = "request";
          try {
            const url = localRequest(req);
            const route = url.pathname.slice(apiPrefix.length);
            if (route === "session" && req.method === "GET") {
              const session = sessions.get(req, res, true);
              return respond(res, 200, {
                csrf: session.csrf,
                accountId: cf.accountId,
              });
            }
            const session = sessions.get(req, res);
            if (req.method === "GET") {
              if (route === "databases")
                return respond(res, 200, {
                  databases: await cf.databases(
                    url.searchParams.get("refresh") === "1",
                  ),
                });
              if (route === "resend") {
                if (resendCache && resendCache.expires > Date.now())
                  return respond(res, 200, resendCache.value);
                // Only this dashboard-specific key is read. Never fall back to the
                // application's send key, and never expose a provider proxy.
                const env = await dashboardEnvironment(docsRoot);
                const key = env.DOCS_DASHBOARD_RESEND_API_KEY;
                if (!key) return respond(res, 200, { configured: false });
                const response = await fetch("https://api.resend.com/usage", {
                  headers: {
                    Authorization: `Bearer ${key}`,
                    "User-Agent": "AfterHoursOutreach-LocalDashboard/1.0",
                  },
                  signal: AbortSignal.timeout(15_000),
                  redirect: "error",
                });
                if (!response.ok)
                  throw new DashboardError(
                    502,
                    `resend_${response.status}`,
                    `Resend usage is unavailable (${response.status}). Check the dashboard-only key has full access; no email has been sent.`,
                  );
                const data = await response.json();
                const usage = Object.fromEntries(
                  [
                    "emails",
                    "contacts",
                    "segments",
                    "broadcasts",
                    "ai_credits",
                    "automation_runs",
                    "domains",
                    "rate_limit",
                  ]
                    .filter((key) => data[key] !== undefined)
                    .map((key) => [key, data[key]]),
                );
                const value = {
                  configured: true,
                  usage,
                  loadedAt: Date.now(),
                  rateLimitRemaining: response.headers.get(
                    "ratelimit-remaining",
                  ),
                  rateLimitReset: response.headers.get("ratelimit-reset"),
                };
                resendCache = { value, expires: Date.now() + 60_000 };
                return respond(res, 200, value);
              }
              databaseId = url.searchParams.get("database") ?? "";
              const db = await cf.database(databaseId);
              if (route === "audit")
                return respond(res, 200, { entries: await log.recent(db.id) });
              if (route === "inspect") {
                const [tables, metadata] = await Promise.all([
                  cf.schema(db),
                  cf.metadata(db),
                ]);
                const missing = missingApplicationSchema(tables);
                return respond(res, 200, {
                  database: db,
                  tables,
                  metadata,
                  compatible: !missing.length,
                  missing,
                  unlockedUntil: unlocked(session, db.id),
                });
              }
              if (route === "metrics") {
                const cached = metricCache.get(db.id);
                if (cached && cached.expires > Date.now())
                  return respond(res, 200, cached.value);
                const value = {
                  days: await cf.metrics(db),
                  loadedAt: Date.now(),
                };
                metricCache.set(db.id, { value, expires: Date.now() + 60_000 });
                return respond(res, 200, value);
              }
              if (!["overview", "users", "roster"].includes(route))
                throw new DashboardError(
                  404,
                  "route_missing",
                  "Dashboard endpoint not found.",
                );
              const tables = await app.requireSchema(db);
              if (route === "overview")
                return respond(res, 200, await app.overview(db, tables));
              if (route === "users") {
                const offset = Number(url.searchParams.get("offset") || 0);
                if (
                  !Number.isSafeInteger(offset) ||
                  offset < 0 ||
                  offset > 100_000
                )
                  throw new DashboardError(
                    400,
                    "invalid_page",
                    "Choose a valid user page.",
                  );
                return respond(
                  res,
                  200,
                  await app.users(
                    db,
                    url.searchParams.get("search") ?? "",
                    url.searchParams.get("filter") ?? "all",
                    offset,
                  ),
                );
              }
              return respond(res, 200, {
                registrations: await app.roster(
                  db,
                  url.searchParams.get("event") ?? "",
                ),
              });
            }
            if (req.method !== "POST") {
              res.setHeader("Allow", "GET, POST");
              throw new DashboardError(
                405,
                "method_not_allowed",
                "Use the dashboard’s supported actions.",
              );
            }
            const body = await readJson(req);
            if (typeof body.database !== "string")
              throw new DashboardError(
                400,
                "database_required",
                "Choose a database first.",
              );
            const db = await cf.database(body.database);
            databaseId = db.id;
            action = route;
            if (route === "unlock" || route === "lock") {
              if (route === "unlock" && body.confirmation !== db.name)
                throw new DashboardError(
                  400,
                  "confirmation_required",
                  "Type the exact database name to unlock writes.",
                );
              await log.append({
                database: db.id,
                action: route,
                outcome: "succeeded",
              });
              if (route === "unlock")
                session.unlocks.set(db.id, Date.now() + 10 * 60_000);
              else {
                session.unlocks.delete(db.id);
                session.plans.clear();
              }
              return respond(res, 200, {
                unlockedUntil: unlocked(session, db.id),
              });
            }
            if (
              db.environment !== "preview" &&
              unlocked(session, db.id) <= Date.now()
            )
              throw new DashboardError(
                423,
                "production_locked",
                "Writes are locked for this database. Unlock it explicitly before reviewing a change.",
              );
            if (route === "plan") {
              if (
                !body.input ||
                typeof body.input !== "object" ||
                Array.isArray(body.input)
              )
                throw new DashboardError(
                  400,
                  "action_required",
                  "Choose an administrative action.",
                );
              const plan = await app.prepare(db, body.input as ActionInput);
              for (const [id, old] of session.plans)
                if (old.expiresAt < Date.now()) session.plans.delete(id);
              if (session.plans.size >= 10) session.plans.clear();
              session.plans.set(plan.token, plan);
              return respond(res, 200, publicPlan(plan));
            }
            if (route !== "execute" || typeof body.token !== "string")
              throw new DashboardError(
                404,
                "route_missing",
                "Dashboard action not found.",
              );
            const plan = session.plans.get(body.token);
            if (
              !plan ||
              plan.databaseId !== db.id ||
              plan.expiresAt <= Date.now()
            )
              throw new DashboardError(
                409,
                "review_expired",
                "This review expired. Open a fresh review before applying changes.",
              );
            if (plan.blocked.length)
              throw new DashboardError(
                409,
                "action_blocked",
                "Resolve the blockers shown in the review before applying this change.",
              );
            if (body.confirmation !== plan.confirmation)
              throw new DashboardError(
                400,
                "confirmation_required",
                "The typed confirmation does not match.",
              );
            if (session.busy || writing.has(db.id))
              throw new DashboardError(
                409,
                "write_in_progress",
                "Another dashboard change is in progress for this database.",
              );
            session.plans.delete(body.token); // single-use, including unconfirmed outcomes
            session.busy = true;
            writing.add(db.id);
            try {
              const fresh = await app.prepare(db, plan.input);
              if (
                fresh.revision !== plan.revision ||
                review(fresh) !== review(plan)
              )
                throw new DashboardError(
                  409,
                  "data_changed",
                  "The data or deletion impact changed since review. Refresh and review again.",
                );
              if (
                plan.expiresAt <= Date.now() ||
                (db.environment !== "preview" &&
                  unlocked(session, db.id) <= Date.now())
              )
                throw new DashboardError(
                  423,
                  "review_expired",
                  "The review or write unlock expired while checking the data. Unlock and review again.",
                );
              const id = await log.append({
                database: db.id,
                action: plan.input.action,
                subject: plan.input.id,
                outcome: "started",
              });
              try {
                await cf.batch(db, fresh.statements);
              } catch (error) {
                await log.append(
                  {
                    database: db.id,
                    action: plan.input.action,
                    subject: plan.input.id,
                    outcome:
                      error instanceof DashboardError &&
                      error.code === "provider_unconfirmed"
                        ? "unknown"
                        : "failed",
                    code:
                      error instanceof DashboardError
                        ? error.code
                        : "provider_error",
                  },
                  id,
                );
                throw error;
              }
              try {
                await log.append(
                  {
                    database: db.id,
                    action: plan.input.action,
                    subject: plan.input.id,
                    outcome: "succeeded",
                  },
                  id,
                );
              } catch {
                throw new DashboardError(
                  500,
                  "audit_completion_failed",
                  "The change was applied, but its completion could not be written to the local log. Do not repeat it; inspect the data and check disk permissions.",
                );
              }
              return respond(res, 200, {
                message:
                  "Change applied. Refreshing data; no notification emails were sent.",
              });
            } finally {
              session.busy = false;
              writing.delete(db.id);
            }
          } catch (error) {
            const known = error instanceof DashboardError;
            const code = known ? error.code : "dashboard_error";
            // No SQL, provider payload, credentials or PII in logs/errors.
            logger.warn(`Dashboard request failed (${code}).`);
            await log
              .append({ database: databaseId, action, outcome: "failed", code })
              .catch(() => {});
            respond(res, known ? error.status : 500, {
              error: known
                ? error.message
                : "The dashboard could not finish this request. Check local credentials, connectivity and audit-directory permissions.",
              code,
            });
          }
        });
      },
    },
  };
}
