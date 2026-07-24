import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const forbidden = [
  "createFs",
  "videocity-engine",
  "X_TOKENS_PATH",
  "x-tokens.json",
  ".kie-task.json",
  ".generation-error.json",
  ".generation-request.json",
  "state.sqlite",
  "metadata.sqlite",
  "runtime.sqlite",
  "first_frame_source",
] as const;

describe("Dolt-native application cutover", () => {
  it("keeps legacy persistence out of production source", async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "..");
    const roots = ["server/src", "src", "scripts"].map((directory) =>
      path.join(repositoryRoot, directory),
    );
    const files = (
      await Promise.all(roots.map((root) => sourceFiles(root)))
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const token of forbidden) {
        if (source.includes(token)) {
          violations.push(
            `${path.relative(repositoryRoot, file)} contains ${token}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(fullPath);
      if (!/\.[cm]?[jt]sx?$/.test(entry.name)) return [];
      return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
        ? []
        : [fullPath];
    }),
  );
  return files.flat();
}
