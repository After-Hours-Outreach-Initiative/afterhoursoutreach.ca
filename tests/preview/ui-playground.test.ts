import { test } from "vitest";
import { assertHostedUiPlaygroundAbsent } from "../helpers/ui-playground-hosted";

test("Preview Worker excludes the local UI playground", async () => {
  await assertHostedUiPlaygroundAbsent("dist-preview/server/wrangler.json");
});
