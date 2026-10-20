import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Bundle fonts locally too: opening a diagram must not require a CDN.
const entry = import.meta.resolve("@excalidraw/excalidraw");
const source = new URL("./fonts/", entry);
const destination = new URL("../public/excalidraw/fonts/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(fileURLToPath(source), fileURLToPath(destination), {
  recursive: true,
});
