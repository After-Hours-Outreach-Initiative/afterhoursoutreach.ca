import { readFileSync, writeFileSync } from "node:fs";

/** The built Worker config without its email binding, as in an unconfigured
 * deployment. Written beside the original so its relative paths still resolve. */
export function withoutEmail(configPath = "dist/server/wrangler.json") {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  delete config.send_email;
  const path = configPath.replace(/\.json$/, ".without-email.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}
