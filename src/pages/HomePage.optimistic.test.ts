import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const homepageSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "HomePage.tsx"),
  "utf8",
);

describe("HomePage optimistic UI reset wiring", () => {
  it("keys renderingOverrides/deletingIds by bookId", () => {
    expect(homepageSrc).toMatch(
      /useProjectScopedState\(bookId, createRenderingOverrides\)[\s\S]*?useProjectScopedState\(bookId, createDeletingIds\)/,
    );
  });

  it("does not clear optimistic UI in the syncCount asset-refresh effect cleanup", () => {
    expect(homepageSrc).not.toMatch(
      /listAssets\(bookId, sortOrder\);\s*return \(\) => \{\s*setRenderingOverrides/,
    );
  });
});

describe("HomePage viewport layout", () => {
  it("sizes the app root against both viewport axes", () => {
    expect(homepageSrc).toContain(
      'className="w-screen h-screen bg-background overflow-x-auto overflow-y-hidden"',
    );
    expect(homepageSrc).not.toContain('className="size-screen');
  });
});

describe("HomePage notebook default layout", () => {
  it("renders default notebook fallback before WAITING FOR INPUT", () => {
    expect(homepageSrc).toMatch(
      /defaultNotebookSelection\s*\?\s*\(?\s*renderViewer\(defaultNotebookSelection\)[\s\S]*?WAITING FOR INPUT/,
    );
  });

  it("wires useEnsureDefaultNotebook hook", () => {
    expect(homepageSrc).toContain("useEnsureDefaultNotebook({");
    expect(homepageSrc).toContain("assetList,");
  });
});
