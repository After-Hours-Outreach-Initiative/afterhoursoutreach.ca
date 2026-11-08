import { expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import sharp from "sharp";

test("dynamic public pages serve resized WebP images with long-lived caching", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: {
          BETTER_AUTH_SECRET:
            "image-optimization-test-secret-12345678901234567890",
          RESEND_API_KEY: "",
        },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    let variants = 0;
    for (const [path, count] of [
      ["/", 2],
      ["/donate", 1],
    ] as const) {
      const response = await worker.fetch(new URL(path, origin));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      const images = [...html.matchAll(/<img\b[^>]*>/g)]
        .map((match) => match[0])
        .filter((image) => image.includes('src="/_image?'));
      expect(images).toHaveLength(count);
      for (const image of images) {
        const srcset = image.match(/\bsrcset="([^"]+)"/)?.[1];
        expect(srcset).toBeDefined();
        for (const candidate of srcset!.replaceAll("&amp;", "&").split(",")) {
          const [src, descriptor] = candidate.trim().split(/\s+/);
          const url = new URL(src, origin);
          expect(url.searchParams.get("w")).toBe(descriptor.slice(0, -1));
          const photo = await worker.fetch(url);
          expect(photo.status).toBe(200);
          expect(photo.headers.get("content-type")).toBe("image/webp");
          expect(photo.headers.get("cache-control")).toBe(
            "public, max-age=31536000, immutable",
          );
          const data = Buffer.from(await photo.arrayBuffer());
          const { width, height, format } = await sharp(data).metadata();
          expect(format).toBe("webp");
          expect(width).toBe(Number(url.searchParams.get("w")));
          expect(height).toBe(Number(url.searchParams.get("h")));
          const repeat = await worker.fetch(url);
          expect(repeat.status).toBe(200);
          expect(Buffer.from(await repeat.arrayBuffer())).toEqual(data);
          variants++;
        }
      }
    }
    expect(variants).toBe(7);
  } finally {
    await server.close();
  }
});
