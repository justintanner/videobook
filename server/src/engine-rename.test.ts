import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scopedEngine } from "./engine.js";

const serverSrc = dirname(fileURLToPath(import.meta.url));

describe("scoped Engine rename", () => {
  it("exports scopedEngine and does not export fs", async () => {
    expect(scopedEngine).toBeDefined();
    const source = await readFile(join(serverSrc, "engine.ts"), "utf8");
    expect(source).toContain("export const scopedEngine");
    expect(source).not.toMatch(/export const fs\b/);
  });

  it("keeps node:fs imports and has no production Engine parameter named fs", async () => {
    const { readdir } = await import("node:fs/promises");
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "dist") continue;
          await walk(path);
          continue;
        }
        if (
          entry.name.endsWith(".ts")
          && !entry.name.endsWith(".test.ts")
          && !entry.name.endsWith(".e2e.test.ts")
        ) {
          files.push(path);
        }
      }
    }
    await walk(serverSrc);
    let nodeFsImports = 0;
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/from "node:fs(?:\/promises)?"/.test(source)) nodeFsImports += 1;
      expect(source, file).not.toMatch(/\bfs: Engine\b/);
    }
    expect(nodeFsImports).toBeGreaterThan(0);
  });
});
