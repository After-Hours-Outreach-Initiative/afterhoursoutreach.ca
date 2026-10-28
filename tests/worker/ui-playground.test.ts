import { test } from "vitest";
import { assertHostedUiPlaygroundAbsent } from "../helpers/ui-playground-hosted";

test("production Worker excludes the local UI playground", async () => {
  await assertHostedUiPlaygroundAbsent("dist/server/wrangler.json");
});
