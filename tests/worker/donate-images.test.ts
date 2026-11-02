import { expect, test } from "vitest";
import { createTestHarness } from "wrangler";

test("donation images request bounded Shopify thumbnails without cropping", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: {
          BETTER_AUTH_SECRET: "donate-images-test-secret-12345678901234567890",
          RESEND_API_KEY: "",
        },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const response = await worker.fetch(`${origin}/donate`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const images = [...html.matchAll(/<img\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((image) => image.includes("https://cdn.shopify.com/"));
    expect(images).toHaveLength(7);
    for (const image of images) {
      const src = image.match(/\bsrc="([^"]+)"/)![1];
      const url = new URL(src.replaceAll("&amp;", "&"));
      const width = image.match(/\bwidth="(\d+)"/)![1];
      expect(["180", "240"]).toContain(width);
      expect(url.searchParams.get("width")).toBe(width);
      expect(url.searchParams.get("quality")).toBe("80");
      expect(url.searchParams.get("v")).toMatch(/^\d+$/);
      expect(url.searchParams.has("crop")).toBe(false);
      expect(url.searchParams.has("height")).toBe(false);
      expect(url.searchParams.has("format")).toBe(false);
      expect(image).toContain('loading="lazy"');
    }
  } finally {
    await server.close();
  }
});
