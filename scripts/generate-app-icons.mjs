import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = new URL("../public/icons/app-icon.svg", import.meta.url);
const icons = new URL("../public/icons/", import.meta.url);
const background = "#050608";

await mkdir(icons, { recursive: true });

for (const size of [180, 192, 512]) {
  const destination = new URL(
    size === 180
      ? "../public/apple-touch-icon.png"
      : `../public/icons/app-icon-${size}.png`,
    import.meta.url,
  );
  await sharp(fileURLToPath(source))
    .resize(size, size)
    .flatten({ background })
    .png()
    .toFile(fileURLToPath(destination));
}

// Keep the artwork inside Android's circular safe area (40% of the width).
await sharp(fileURLToPath(source))
  .resize(410, 410)
  .flatten({ background })
  .extend({ top: 51, bottom: 51, left: 51, right: 51, background })
  .png()
  .toFile(fileURLToPath(new URL("app-icon-maskable-512.png", icons)));
