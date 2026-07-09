import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const homepageSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "HomePage.tsx"),
  "utf8",
);

describe("HomePage optimistic UI reset wiring", () => {
  it("clears renderingOverrides/deletingIds only when projectSlug changes", () => {
    expect(homepageSrc).toMatch(
      /setRenderingOverrides\(new Map\(\)\)\s*;\s*setDeletingIds\(new Set\(\)\)\s*;\s*\}, \[projectSlug\]\)/,
    );
  });

  it("does not clear optimistic UI in the syncCount asset-refresh effect cleanup", () => {
    expect(homepageSrc).not.toMatch(
      /listAssets\(projectSlug, sortOrder\);\s*return \(\) => \{\s*setRenderingOverrides/,
    );
  });
});
