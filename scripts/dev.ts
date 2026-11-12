import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { localAccountUserId } from "../src/dev/accounts";

// Start the background dev server, then seed the local samples once.
const run = (command: string, args: string[], quiet = false) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
    env: { ...process.env, CLOUDFLARE_ENV: "" },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message ||
        result.stderr?.trim() ||
        `${command} ${args.join(" ")} failed`,
    );
  return result.stdout ?? "";
};

run("pnpm", ["exec", "wrangler", "types", "--strict-vars", "false"]);
run("pnpm", ["db:migrate:local"]);
run("pnpm", ["exec", "astro", "dev", "--host", "--background"]);

// Another checkout's server may hold the default port; ask for the real one.
const status = run("pnpm", ["exec", "astro", "dev", "status"], true);
const origin = status.match(/http:\/\/localhost:\d+/)?.[0];
if (!origin) throw new Error(`Could not find the dev server URL.\n${status}`);

for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(`${origin}/api/v1/auth/dev/users`)).ok) break;
  } catch {
    // Still starting.
  }
  if (attempt === 120)
    throw new Error("The dev server did not become ready in time.");
  await sleep(500);
}

const seeded = JSON.parse(
  run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--json",
      "--command",
      `SELECT count(*) AS n FROM user WHERE id = '${localAccountUserId("organizer")}'`,
    ],
    true,
  ),
)[0].results[0].n;
if (seeded) console.log("Local samples are already seeded.");
else
  spawnSync("pnpm", ["db:seed:local"], {
    stdio: "inherit",
    env: { ...process.env, LOCAL_BASE_URL: origin },
  });
console.log(`Dev server running at ${origin}`);
