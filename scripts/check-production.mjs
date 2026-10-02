import { unstable_readConfig as readConfig } from "wrangler";

const config = readConfig({ config: "wrangler.jsonc" });
if (
  !config.d1_databases.length ||
  config.d1_databases.some(
    (database) =>
      !database.database_id ||
      database.database_id === "00000000-0000-0000-0000-000000000000" ||
      config.previews?.d1_databases?.some(
        (preview) => preview.database_id === database.database_id,
      ),
  )
) {
  console.error(
    "Production deployment blocked: configure a real production D1 database, separate from previews, before deploying.",
  );
  process.exit(1);
}
