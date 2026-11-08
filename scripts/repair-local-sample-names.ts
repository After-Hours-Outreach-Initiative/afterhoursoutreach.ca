import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig as readConfig } from "wrangler";
import { localSampleNameRepair } from "./local-sample-name-repair";

if (process.argv.length !== 2)
  throw new Error("Usage: pnpm db:repair:local-names (local only)");
const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = join(root, "wrangler.jsonc");
const config: { d1_databases?: { binding: string; remote?: boolean }[] } =
  readConfig({ config: configPath, env: "" });
if (
  !config.d1_databases?.some((db) => db.binding === "DB" && db.remote === false)
)
  throw new Error("Name repair requires the project's local D1 binding.");

// Protect the full backup (including local credentials) from its creation.
process.umask(0o077);
const directory = await mkdtemp("/tmp/opencode/local-sample-names-");
const sqlFile = join(directory, "queries.sql");
function wrangler(command: "execute" | "export", args: string[]) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      command,
      "DB",
      "--config",
      configPath,
      "--local",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ENV: "" },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message || result.stderr || "Local D1 command failed.",
    );
  return result.stdout;
}
async function execute(statements: string[]) {
  await writeFile(sqlFile, statements.join(";\n") + ";\n", { mode: 0o600 });
  const results: { results: Record<string, unknown>[]; success: boolean }[] =
    JSON.parse(wrangler("execute", ["--file", sqlFile, "--json"]));
  if (results.some((result) => !result.success))
    throw new Error("Local name repair failed.");
  return results.flatMap((result) => result.results);
}
try {
  const repair = localSampleNameRepair();
  const before = await execute(repair.inventory);
  await writeFile(
    join(directory, "inventory.json"),
    JSON.stringify(before, null, 2),
    {
      mode: 0o600,
    },
  );
  if (!before.length) {
    console.log("No known local sample names need repair.");
  } else {
    const backup = join(directory, "before.sql");
    wrangler("export", ["--output", backup]);
    await chmod(backup, 0o600);
    console.log(`Local D1 backup: ${backup}`);
    await execute(repair.statements);
    if ((await execute(repair.inventory)).length)
      throw new Error(
        "Some local sample names still need repair; backup retained.",
      );
    const preferred = before.filter(
      (row) => row.preferred_name !== row.first_name,
    ).length;
    const display = before.filter(
      (row) => row.name !== row.repaired_name,
    ).length;
    console.log(
      `Repaired ${before.length} local samples: ${preferred} preferred first names and ${display} display names. No other fields were changed.`,
    );
  }
} finally {
  await unlink(sqlFile);
}
