import type { AstroIntegration } from "astro";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const prefix = "/__docs/diagrams/";
const maxBytes = 10 * 1024 * 1024;
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function revision(contents: string | Buffer) {
  return `"${createHash("sha256").update(contents).digest("hex")}"`;
}

function respond(
  res: ServerResponse,
  status: number,
  data: unknown,
  etag?: string,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (etag) res.setHeader("ETag", etag);
  res.end(JSON.stringify(data));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScene(value: unknown) {
  if (
    !isRecord(value) ||
    value.type !== "excalidraw" ||
    value.version !== 2 ||
    !Array.isArray(value.elements) ||
    !isRecord(value.appState) ||
    !isRecord(value.files)
  ) {
    return false;
  }
  const ids = new Set<string>();
  return value.elements.every((element: unknown) => {
    if (
      !isRecord(element) ||
      typeof element.id !== "string" ||
      typeof element.type !== "string" ||
      ids.has(element.id)
    )
      return false;
    ids.add(element.id);
    return true;
  });
}

async function readScene(req: IncomingMessage): Promise<unknown> {
  if (
    req.headers["content-type"]?.split(";")[0].trim() !== "application/json"
  ) {
    throw new RequestError(415, "Send the diagram as JSON.");
  }
  if (Number(req.headers["content-length"]) > maxBytes) {
    throw new RequestError(413, "The diagram exceeds the 10 MiB save limit.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes)
      throw new RequestError(413, "The diagram exceeds the 10 MiB save limit.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "The diagram is not valid JSON.");
  }
}

export default function diagramFiles(): AstroIntegration {
  return {
    name: "local-diagram-files",
    hooks: {
      // No file-writing endpoint is registered for builds or production previews.
      "astro:server:setup": async ({ server, logger }) => {
        const directory = join(server.config.publicDir, "diagrams");
        const files = new Map(
          (await readdir(directory, { withFileTypes: true }))
            .filter(
              (entry) =>
                entry.isFile() &&
                /^[a-z0-9]+(?:-[a-z0-9]+)*\.excalidraw$/.test(entry.name),
            )
            .map((entry) => [entry.name, join(directory, entry.name)] as const),
        );
        const saving = new Set<string>();

        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith(prefix)) return next();
          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (
              !loopbackAddresses.has(req.socket.remoteAddress ?? "") ||
              !loopbackHosts.has(url.hostname) ||
              (req.headers.origin && req.headers.origin !== url.origin)
            ) {
              throw new RequestError(
                403,
                "Diagram files are only available to the local docs site.",
              );
            }
            const name = url.pathname.slice(prefix.length);
            const path = files.get(name);
            if (!path)
              throw new RequestError(
                404,
                "This diagram file is not available.",
              );
            const info = await lstat(path);
            if (!info.isFile())
              throw new RequestError(
                403,
                "Only regular diagram files can be saved.",
              );

            if (req.method === "GET") {
              const contents = await readFile(path);
              res.setHeader("ETag", revision(contents));
              res.setHeader("Cache-Control", "no-store");
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.setHeader("X-Content-Type-Options", "nosniff");
              res.end(contents);
              return;
            }
            if (req.method !== "PUT") {
              res.setHeader("Allow", "GET, PUT");
              throw new RequestError(405, "Use PUT to save a diagram.");
            }
            if (
              req.headers.origin !== url.origin ||
              (req.headers["sec-fetch-site"] &&
                req.headers["sec-fetch-site"] !== "same-origin")
            ) {
              throw new RequestError(
                403,
                "Save requests must come from this docs site.",
              );
            }
            const expected = req.headers["if-match"];
            if (typeof expected !== "string") {
              throw new RequestError(428, "Reload the diagram before saving.");
            }
            const scene = await readScene(req);
            if (!isScene(scene))
              throw new RequestError(
                400,
                "The data is not an Excalidraw scene.",
              );
            if (saving.has(name))
              throw new RequestError(
                409,
                "This diagram is already being saved. Try again.",
              );

            saving.add(name);
            const temporary = `${path}.${randomUUID()}.tmp`;
            try {
              if (revision(await readFile(path)) !== expected) {
                throw new RequestError(
                  412,
                  "The file changed on disk. Reload before saving to avoid overwriting newer changes.",
                );
              }
              const contents = `${JSON.stringify(scene, null, 2)}\n`;
              await writeFile(temporary, contents, {
                flag: "wx",
                mode: info.mode & 0o777,
              });
              // Check again after writing the temporary file, before replacing the source.
              if (revision(await readFile(path)) !== expected) {
                throw new RequestError(
                  412,
                  "The file changed on disk. Reload before saving to avoid overwriting newer changes.",
                );
              }
              await rename(temporary, path);
              respond(res, 200, { saved: name }, revision(contents));
            } finally {
              saving.delete(name);
              await unlink(temporary).catch(() => {});
            }
          } catch (error) {
            if (error instanceof RequestError) {
              respond(res, error.status, { error: error.message });
            } else {
              logger.error(
                `Diagram file request failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              respond(res, 500, {
                error:
                  "Could not access the diagram file. Your canvas has not changed.",
              });
            }
          }
        });
      },
    },
  };
}
