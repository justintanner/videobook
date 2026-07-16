import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const homepageSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "HomePage.tsx"),
  "utf8",
);

describe("HomePage optimistic UI reset wiring", () => {
  it("keys renderingOverrides/deletingIds by projectSlug", () => {
    expect(homepageSrc).toMatch(
      /useProjectScopedState\(projectSlug, createRenderingOverrides\)[\s\S]*?useProjectScopedState\(projectSlug, createDeletingIds\)/,
    );
  });

  it("does not clear optimistic UI in the syncCount asset-refresh effect cleanup", () => {
    expect(homepageSrc).not.toMatch(
      /listAssets\(projectSlug, sortOrder\);\s*return \(\) => \{\s*setRenderingOverrides/,
    );
  });
});
