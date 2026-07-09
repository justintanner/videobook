import { describe, it, expect } from "vitest";
import { shouldApplyListAssetsResult } from "./useListAssets";

describe("shouldApplyListAssetsResult", () => {
  it("applies when request is the latest for the active project", () => {
    expect(shouldApplyListAssetsResult(3, 3, "proj-b", "proj-b")).toBe(true);
  });

  it("rejects a stale sequence after a newer request started", () => {
    expect(shouldApplyListAssetsResult(1, 2, "proj-a", "proj-a")).toBe(false);
  });

  it("rejects a response for a project that is no longer active", () => {
    expect(shouldApplyListAssetsResult(2, 2, "proj-a", "proj-b")).toBe(false);
  });

  it("rejects when clearAssets nulled the active project", () => {
    expect(shouldApplyListAssetsResult(1, 1, "proj-a", null)).toBe(false);
  });
});
