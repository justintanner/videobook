import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const LEGACY_TOOL_NAME = /\b(?:generate|extend|upscale)_(?:kie|fal|google_flow|xai|alibaba|elevenlabs)_\w+/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sourceFiles(path);
    return /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) ? [path] : [];
  });
}

describe("generation tool names", () => {
  it("keeps per-provider generation tool names out of the source", () => {
    const offenders = [...sourceFiles(resolve(root, "server/src")), ...sourceFiles(resolve(root, "src"))]
      .filter((path) => LEGACY_TOOL_NAME.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
