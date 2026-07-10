import { describe, it, expect } from "vitest";
import type { RenameRow } from "./rename-all-server-types";
import {
  toEditableRows,
  mergeRevalidated,
  editRowName,
  toggleRowIncluded,
  hasDirtyRows,
  canConfirm,
  buildRevalidatePayload,
  buildApplyPayload,
  previewTargetSlug,
  statusLabel,
  resolvePreviewUrls,
} from "./rename-all-helpers";

function row(overrides: Partial<RenameRow> = {}): RenameRow {
  return {
    asset_id: "vid-aaa",
    type: "video",
    current_slug: "vid-aaa",
    current_name: "Aaa",
    suggested_name: "sunset beach",
    target_asset_id: "vid-sunset-beach",
    status: "renamable",
    ...overrides,
  };
}

describe("toEditableRows", () => {
  it("marks renamable rows as included", () => {
    const editable = toEditableRows([row()]);
    expect(editable[0].included).toBe(true);
    expect(editable[0].draftName).toBe("sunset beach");
    expect(editable[0].dirty).toBe(false);
  });

  it("leaves skipped rows excluded", () => {
    const editable = toEditableRows([row({ status: "skipped", suggested_name: "" })]);
    expect(editable[0].included).toBe(false);
  });
});

describe("editRowName", () => {
  it("updates draft and marks dirty when name changes", () => {
    const editable = toEditableRows([row()]);
    const updated = editRowName(editable, "vid-aaa", "stormy ocean");
    expect(updated[0].draftName).toBe("stormy ocean");
    expect(updated[0].dirty).toBe(true);
  });

  it("does not mark dirty when unchanged", () => {
    const editable = toEditableRows([row({ suggested_name: "sunset beach" })]);
    const updated = editRowName(editable, "vid-aaa", "sunset beach");
    expect(updated[0].dirty).toBe(false);
  });
});

describe("toggleRowIncluded", () => {
  it("flips included state", () => {
    const editable = toEditableRows([row()]);
    expect(editable[0].included).toBe(true);
    const off = toggleRowIncluded(editable, "vid-aaa");
    expect(off[0].included).toBe(false);
    const on = toggleRowIncluded(off, "vid-aaa");
    expect(on[0].included).toBe(true);
  });
});

describe("mergeRevalidated", () => {
  it("replaces server-validated rows while preserving the user's include toggle", () => {
    const editable = toEditableRows([
      row({ asset_id: "vid-aaa", target_asset_id: "vid-sunset-beach" }),
    ]);
    // User excludes the row
    const excluded = toggleRowIncluded(editable, "vid-aaa");
    const revalidated: RenameRow[] = [
      row({ asset_id: "vid-aaa", target_asset_id: "vid-stormy-ocean", suggested_name: "stormy ocean" }),
    ];
    const merged = mergeRevalidated(excluded, revalidated);
    expect(merged[0].target_asset_id).toBe("vid-stormy-ocean");
    expect(merged[0].draftName).toBe("stormy ocean");
    expect(merged[0].dirty).toBe(false);
    // User's exclusion is honored even though the row is renamable
    expect(merged[0].included).toBe(false);
  });

  it("includes renamable server rows when previously included", () => {
    const editable = toEditableRows([row()]);
    const revalidated: RenameRow[] = [row({ target_asset_id: "vid-new-target" })];
    const merged = mergeRevalidated(editable, revalidated);
    expect(merged[0].included).toBe(true);
    expect(merged[0].target_asset_id).toBe("vid-new-target");
  });

  it("forces excluded when server says conflict", () => {
    const editable = toEditableRows([row()]);
    const revalidated: RenameRow[] = [row({ status: "conflict", reason: "taken" })];
    const merged = mergeRevalidated(editable, revalidated);
    expect(merged[0].included).toBe(false);
  });
});

describe("hasDirtyRows", () => {
  it("true when an included row is dirty", () => {
    let editable = toEditableRows([row()]);
    editable = editRowName(editable, "vid-aaa", "new name");
    expect(hasDirtyRows(editable)).toBe(true);
  });

  it("false for dirty excluded rows", () => {
    let editable = toEditableRows([row()]);
    editable = toggleRowIncluded(editable, "vid-aaa"); // exclude
    editable = editRowName(editable, "vid-aaa", "new name");
    expect(hasDirtyRows(editable)).toBe(false);
  });
});

describe("canConfirm", () => {
  it("true with at least one renamable included row and no dirty rows", () => {
    const editable = toEditableRows([row()]);
    expect(canConfirm(editable)).toBe(true);
  });

  it("false when all rows excluded", () => {
    const editable = toEditableRows([row()]);
    const excluded = toggleRowIncluded(editable, "vid-aaa");
    expect(canConfirm(excluded)).toBe(false);
  });

  it("false when a row is dirty (needs revalidation)", () => {
    let editable = toEditableRows([row()]);
    editable = editRowName(editable, "vid-aaa", "changed");
    expect(canConfirm(editable)).toBe(false);
  });

  it("false when an included row is a conflict", () => {
    const editable = toEditableRows([row({ status: "conflict", included: true } as unknown as RenameRow)]);
    // toEditableRows sets included=false for non-renamable, so force it true
    editable[0].included = true;
    expect(canConfirm(editable)).toBe(false);
  });
});

describe("buildRevalidatePayload", () => {
  it("includes all non-skipped rows with trimmed draft names", () => {
    const editable = toEditableRows([
      row({ asset_id: "vid-a", suggested_name: "keep" }),
      row({ asset_id: "vid-b", status: "skipped", suggested_name: "" }),
    ]);
    const payload = buildRevalidatePayload(editable);
    expect(payload).toEqual([{ asset_id: "vid-a", suggested_name: "keep" }]);
  });

  it("trims whitespace", () => {
    let editable = toEditableRows([row({ suggested_name: "x" })]);
    editable = editRowName(editable, "vid-aaa", "  padded  ");
    expect(buildRevalidatePayload(editable)[0].suggested_name).toBe("padded");
  });
});

describe("buildApplyPayload", () => {
  it("only includes included renamable rows using the validated suggested_name", () => {
    const editable = toEditableRows([
      row({ asset_id: "vid-a", suggested_name: "sunset", target_asset_id: "vid-sunset" }),
      row({ asset_id: "vid-b", status: "skipped" }),
    ]);
    const payload = buildApplyPayload(editable);
    expect(payload).toEqual([{ asset_id: "vid-a", suggested_name: "sunset" }]);
  });

  it("drops excluded rows", () => {
    const editable = toEditableRows([row()]);
    const excluded = toggleRowIncluded(editable, "vid-aaa");
    expect(buildApplyPayload(excluded)).toEqual([]);
  });
});

describe("previewTargetSlug", () => {
  it("computes base slug client-side", () => {
    expect(previewTargetSlug("sunset beach", "vid-old", new Set())).toBe("vid-sunset-beach");
  });

  it("suffixes on collision", () => {
    expect(previewTargetSlug("sunset beach", "vid-old", new Set(["vid-sunset-beach"]))).toBe(
      "vid-sunset-beach-2",
    );
  });

  it("keeps own slot free when colliding with current id", () => {
    expect(previewTargetSlug("fox", "vid-fox", new Set(["vid-fox"]))).toBe("vid-fox");
  });
});

describe("statusLabel", () => {
  it("labels each status", () => {
    expect(statusLabel({ ...row(), status: "skipped", included: false } as never)).toBe("skipped");
    expect(statusLabel({ ...row(), status: "unchanged", included: true } as never)).toBe("no change");
    expect(statusLabel({ ...row(), status: "conflict", included: false } as never)).toBe("conflict");
    expect(statusLabel({ ...row(), status: "renamable", included: true } as never)).toBe("will rename");
    expect(statusLabel({ ...row(), status: "renamable", included: false } as never)).toBe("excluded");
  });
});

describe("resolvePreviewUrls", () => {
  it("picks first and last original_frames for videos", () => {
    const urls = resolvePreviewUrls({
      type: "video",
      frameDirs: {
        original_frames: [
          "/files/p/vid-a/original_frames/9.91.jpg",
          "/files/p/vid-a/original_frames/0.00.jpg",
          "/files/p/vid-a/original_frames/4.95.jpg",
        ],
      },
    });
    expect(urls.first).toContain("0.00.jpg");
    expect(urls.last).toContain("9.91.jpg");
  });

  it("falls back to poster when no frames", () => {
    const urls = resolvePreviewUrls({
      type: "video",
      thumbnailSrc: "/files/p/vid-a/original.jpg",
    });
    expect(urls.first).toBe("/files/p/vid-a/original.jpg");
    expect(urls.last).toBe("/files/p/vid-a/original.jpg");
  });

  it("uses thumbnail for images", () => {
    const urls = resolvePreviewUrls({
      type: "image",
      thumbnailSrc: "/files/p/img-a/original.jpg",
      filePath: "/files/p/img-a/original.png",
    });
    expect(urls.first).toBe("/files/p/img-a/original.jpg");
    expect(urls.last).toBeNull();
  });
});
