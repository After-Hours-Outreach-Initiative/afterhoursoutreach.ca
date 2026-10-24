import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "vitest";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(source, { recursive: true, encoding: "utf8" })
  .filter((path) => /\.(?:css|astro)$/.test(path))
  .sort();

test("authored UI font sizes and arbitrary layout utilities use relative units", () => {
  const violations: string[] = [];
  for (const path of files) {
    const text = readFileSync(join(source, path), "utf8");
    const styles = path.endsWith(".css")
      ? text
      : [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
          .map((match) => match[1])
          .join("\n");
    for (const match of styles.matchAll(
      /font-size\s*:[^;{}]*\b\d+(?:\.\d+)?px\b/g,
    ))
      violations.push(`${path}: ${match[0]}`);
    for (const match of text.matchAll(
      /\b[\w:-]+-\[[^\]\n]*\b\d+(?:\.\d+)?px\b[^\]\n]*\]/g,
    ))
      violations.push(`${path}: ${match[0]}`);
  }
  // Server-generated transactional emails are intentionally outside this scan:
  // their pixel sizing is unrelated to the browser's UI font preferences.
  expect(violations).toEqual([]);
});
