import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, "..");
const BROWSER_SAFE_FILES = ["plan.ts"];
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

describe("browser-safe auto-edit files", () => {
  it.each(BROWSER_SAFE_FILES)("%s reaches only browser-safe auto-edit modules with no server imports", (name) => {
    const files = reachableFiles(join(HERE, name));
    expect(files.every((file) => BROWSER_SAFE_FILES.includes(relative(HERE, file)))).toBe(true);
    const problems = files.flatMap((file) => valueImports(file)
      .filter((specifier) => forbidden(specifier) || (!specifier.startsWith(".") && specifier !== "zod"))
      .map((specifier) => `${relative(SERVER_SRC, file)} imports ${specifier}`));
    expect(problems).toEqual([]);
  });

  it("detects server dependencies in render.ts", () => {
    expect(valueImports(join(HERE, "render.ts")).filter(forbidden)).toEqual(
      expect.arrayContaining(["node:child_process", "node:fs/promises", "node:path"]),
    );
  });
});
