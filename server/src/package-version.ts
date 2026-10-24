import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function installedPackageVersion(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  while (dir !== dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name === name && manifest.version) return manifest.version;
    } catch { void 0; }
    dir = dirname(dir);
  }
  return "unknown";
}
