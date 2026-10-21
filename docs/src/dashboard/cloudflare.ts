import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { experimental_readRawConfig } from "wrangler";
import type { Database, Row, SchemaTable } from "./types";

export class DashboardError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Statement {
  sql: string;
  params?: (string | number | null)[];
}
interface QueryResult {
  success: boolean;
  results: Row[];
  meta: {
    changes?: number;
    duration?: number;
    rows_read?: number;
    rows_written?: number;
  };
}

export async function dashboardEnvironment(docsRoot: string) {
  const env: Record<string, string | undefined> = {};
  for (const file of [".env", ".env.local"]) {
    try {
      Object.assign(
        env,
        parseEnv(await readFile(join(docsRoot, file), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { ...env, ...process.env };
}

export class Cloudflare {
  private credentials?: { headers: Record<string, string>; expires: number };
  private authenticating?: Promise<Record<string, string>>;
  private catalog?: { databases: Database[]; expires: number };
  readonly accountId: string;
  private previewIds: Set<string>;
  private cli: string;

  constructor(
    readonly root: string,
    readonly env: Record<string, string | undefined>,
  ) {
    const main = experimental_readRawConfig({
      config: join(root, "wrangler.jsonc"),
    }).rawConfig;
    const preview = experimental_readRawConfig({
      config: join(root, "wrangler.preview-migrations.jsonc"),
    }).rawConfig;
    this.accountId = env.DOCS_DASHBOARD_ACCOUNT_ID || main.account_id || "";
    if (!/^[a-f0-9]{32}$/.test(this.accountId))
      throw new Error(
        "Set DOCS_DASHBOARD_ACCOUNT_ID to a Cloudflare account ID.",
      );
    // Never infer safety from a name such as staging/test. Unknown targets lock.
    this.previewIds = new Set(
      preview.account_id === this.accountId
        ? (preview.d1_databases ?? []).map(
            (db: { database_id: string }) => db.database_id,
          )
        : [],
    );
    const require = createRequire(join(root, "package.json"));
    this.cli = join(
      dirname(require.resolve("wrangler/package.json")),
      "bin/wrangler.js",
    );
  }

  private async auth(): Promise<Record<string, string>> {
    if (this.credentials && this.credentials.expires > Date.now())
      return this.credentials.headers;
    if (this.authenticating) return this.authenticating;
    this.authenticating = new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          this.cli,
          "auth",
          "token",
          "--json",
          "--config",
          join(this.root, "wrangler.jsonc"),
        ],
        {
          cwd: this.root,
          timeout: 25_000,
          maxBuffer: 128 * 1024,
          env: {
            ...process.env,
            CLOUDFLARE_ENV: "",
            WRANGLER_SEND_METRICS: "false",
          },
        },
        (error, stdout) =>
          error
            ? reject(
                new DashboardError(
                  401,
                  "wrangler_auth",
                  "Wrangler authentication is unavailable. Run pnpm exec wrangler login from the repository root, then reconnect.",
                ),
              )
            : resolve(stdout),
      );
    })
      .then((stdout) => {
        // Capture privately; do not log stdout/stderr or attach child-process errors.
        const value = JSON.parse(stdout);
        const headers: Record<string, string> =
          value.type === "api_key"
            ? { "X-Auth-Key": value.key, "X-Auth-Email": value.email }
            : { Authorization: `Bearer ${value.token}` };
        if (!value.token && !(value.key && value.email))
          throw new Error("Missing credentials");
        this.credentials = { headers, expires: Date.now() + 5 * 60_000 };
        return headers;
      })
      .catch((error: unknown) => {
        if (error instanceof DashboardError) throw error;
        throw new DashboardError(
          401,
          "wrangler_auth",
          "Could not read Wrangler credentials. Sign in with the project’s Wrangler CLI.",
        );
      })
      .finally(() => {
        this.authenticating = undefined;
      });
    return this.authenticating;
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(await this.auth()), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25_000),
        redirect: "error",
      });
    } catch (error) {
      if (error instanceof DashboardError) throw error;
      throw new DashboardError(
        504,
        "provider_unconfirmed",
        "Cloudflare did not confirm the request. Refresh the data before retrying any change.",
      );
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object")
      throw new DashboardError(
        502,
        "provider_unconfirmed",
        "Cloudflare returned an unreadable response. Refresh the data before retrying any change.",
      );
    if (!response.ok || data?.success === false || data?.errors?.length) {
      if (response.status === 401 || response.status === 403)
        this.credentials = undefined;
      const raw = JSON.stringify(data?.errors ?? []);
      const rule = [
        "last_organizer",
        "approval_requires_organizer",
        "minimum_capacity",
        "capacity_below_signups",
        "reservation_edit_conflict",
        "FOREIGN KEY",
        "dashboard_conflict",
      ].find((name) => raw.includes(name));
      const conflict = raw.includes("malformed JSON");
      throw new DashboardError(
        response.status === 429 ? 429 : conflict ? 409 : 502,
        rule ||
          (conflict ? "dashboard_conflict" : `cloudflare_${response.status}`),
        conflict
          ? "The target changed or a safety precondition no longer holds. Refresh and review the change again."
          : rule
            ? `Database safety rule refused the change (${rule}). Refresh and review the account or event.`
            : `Cloudflare refused the request (${response.status}). Check D1 Read/Write permissions; analytics also requires Account Analytics Read. No automatic write retry is performed.`,
      );
    }
    return data as T;
  }

  async databases(refresh = false) {
    if (!refresh && this.catalog && this.catalog.expires > Date.now())
      return this.catalog.databases;
    const databases: Database[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.request<{
        result: { uuid: string; name: string }[];
        result_info?: { total_count?: number };
      }>(`/accounts/${this.accountId}/d1/database?per_page=100&page=${page}`);
      for (const db of data.result)
        databases.push({
          id: db.uuid,
          name: db.name,
          accountId: this.accountId,
          environment: this.previewIds.has(db.uuid) ? "preview" : "protected",
        });
      if (
        data.result.length < 100 ||
        databases.length >= (data.result_info?.total_count ?? Infinity)
      )
        break;
    }
    this.catalog = { databases, expires: Date.now() + 60_000 };
    return databases;
  }

  async database(id: string) {
    const db = (await this.databases()).find((entry) => entry.id === id);
    if (!db)
      throw new DashboardError(
        404,
        "database_missing",
        "Choose a database from this account’s discovered list.",
      );
    return db;
  }

  private path(db: Database) {
    return `/accounts/${db.accountId}/d1/database/${db.id}`;
  }
  async metadata(db: Database) {
    const data = await this.request<{ result: Record<string, unknown> }>(
      this.path(db),
    );
    const result = data.result;
    return Object.fromEntries(
      [
        "name",
        "uuid",
        "created_at",
        "file_size",
        "num_tables",
        "version",
        "jurisdiction",
        "read_replication",
      ]
        .filter((key) => result[key] !== undefined)
        .map((key) => [key, result[key]]),
    );
  }
  async batch(db: Database, statements: Statement[]) {
    const data = await this.request<{ result: QueryResult[] }>(
      `${this.path(db)}/query`,
      { batch: statements },
    );
    if (
      !Array.isArray(data.result) ||
      data.result.length !== statements.length ||
      data.result.some((item) => item.success === false)
    )
      throw new DashboardError(
        502,
        "provider_unconfirmed",
        "Cloudflare returned an incomplete result. Refresh before retrying a change.",
      );
    return data.result;
  }
  async rows(db: Database, sql: string, params: Statement["params"] = []) {
    return (await this.batch(db, [{ sql, params }]))[0].results ?? [];
  }
  async schema(db: Database): Promise<SchemaTable[]> {
    const tables = await this.rows(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name LIMIT 1001",
    );
    if (tables.length > 1000)
      throw new DashboardError(
        422,
        "schema_limit",
        "This database has more than 1,000 tables. App operations are disabled rather than inspecting an incomplete dependency graph.",
      );
    if (!tables.length) return [];
    const columns: QueryResult[] = [];
    for (let offset = 0; offset < tables.length; offset += 25) {
      columns.push(
        ...(await this.batch(
          db,
          tables.slice(offset, offset + 25).map((table) => ({
            sql: "SELECT name FROM pragma_table_info(?)",
            params: [table.name],
          })),
        )),
      );
    }
    return tables.map((table, index) => ({
      name: String(table.name),
      columns: columns[index].results.map((row) => String(row.name)),
    }));
  }
  async metrics(db: Database) {
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 6 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const data = await this.request<{
      data?: {
        viewer: { accounts: { d1AnalyticsAdaptiveGroups: unknown[] }[] };
      };
      errors?: unknown[];
    }>("/graphql", {
      query: `query DashboardD1($account: string!, $database: string!, $start: Date!, $end: Date!) {
        viewer { accounts(filter: { accountTag: $account }) { d1AnalyticsAdaptiveGroups(limit: 7, filter: { databaseId: $database, date_geq: $start, date_leq: $end }, orderBy: [date_ASC]) {
          dimensions { date } sum { readQueries writeQueries rowsRead rowsWritten } quantiles { queryBatchTimeMsP90 }
        } } } }`,
      variables: { account: db.accountId, database: db.id, start, end: today },
    });
    return data.data?.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups ?? [];
  }
}
