import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, "..");
const BROWSER_SAFE_FILES = [
  "model.ts",
  "edits.ts",
  "slots.ts",
  "starters.ts",
  "watermark-profile.ts",
  "layout.ts",
  "timing.ts",
  "stills.ts",
  "fonts.ts",
  "qr.ts",
  "icons.ts",
];
const MODULE_SPECIFIER = /^\s*(?:import|export)\s+(type\s+)?[\w$*{}\s,]*?\s*from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gmu;
const BUILTINS = new Set(builtinModules);

function valueImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(MODULE_SPECIFIER)]
    .filter((match) => !match[1])
    .map((match) => match[2] ?? match[3]);
}

function sourceFile(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier.replace(/\.js$/u, ""));
  const found = [".ts", ".tsx"].map((extension) => `${base}${extension}`).find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Cannot resolve ${specifier} from ${from}`);
  return found;
}

function reachableFiles(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of valueImports(file)) {
      if (specifier.startsWith(".")) pending.push(sourceFile(file, specifier));
    }
  }
  return [...seen];
}

function forbidden(specifier: string): boolean {
  return specifier.startsWith("node:")
    || BUILTINS.has(specifier)
    || specifier === "sharp"
    || specifier === "videobook-engine"
    || specifier.startsWith("videobook-engine/");
}

describe("browser-safe graphics files", () => {
  const entries = BROWSER_SAFE_FILES.map((name) => join(HERE, name)).filter((file) => existsSync(file));

  it("covers the files this step adds", () => {
    expect(entries.map((file) => relative(HERE, file))).toEqual(expect.arrayContaining(["model.ts", "edits.ts", "slots.ts", "starters.ts", "watermark-profile.ts"]));
  });

  it.each(entries.map((file) => [relative(HERE, file), file] as const))("%s reaches no node:, sharp or engine value import", (_name, file) => {
    const problems = reachableFiles(file).flatMap((source) => valueImports(source)
      .filter(forbidden)
      .map((specifier) => `${relative(SERVER_SRC, source)} imports ${specifier}`));
    expect(problems).toEqual([]);
  });

  it("notices a forbidden import", () => {
    expect(valueImports(join(SERVER_SRC, "jobs", "burn-watermark.ts")).filter(forbidden)).toEqual(expect.arrayContaining(["node:fs/promises", "node:path"]));
    expect(valueImports(join(SERVER_SRC, "watermark-badge.ts")).filter(forbidden)).toEqual(["sharp"]);
  });
});
