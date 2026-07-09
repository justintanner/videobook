import { describe, expect, it } from "vitest";
import { characterRefImageCount, OMNI_MAX_REFERENCE_IMAGES, totalOmniReferenceImages } from "./google-flow-refs.js";

describe("characterRefImageCount", () => {
  it("parses -imgs:2", () => {
    expect(characterRefImageCount("character:abc-email:def-imgs:2")).toBe(2);
  });

  it("defaults a bare ref to 1", () => {
    expect(characterRefImageCount("character:abc-email:def")).toBe(1);
  });

  it("clamps -imgs:9 to 2", () => {
    expect(characterRefImageCount("character:abc-imgs:9")).toBe(2);
  });

  it("clamps -imgs:0 to 1", () => {
    expect(characterRefImageCount("character:abc-imgs:0")).toBe(1);
  });

  it("returns 1 for malformed suffix", () => {
    expect(characterRefImageCount("character:abc-imgs:x")).toBe(1);
  });
});

describe("totalOmniReferenceImages", () => {
  it("sums image refs + per-character counts", () => {
    expect(totalOmniReferenceImages(3, ["character:a-imgs:2", "character:b-imgs:2"])).toBe(7);
  });

  it("overflows when combined budget exceeds 7", () => {
    expect(totalOmniReferenceImages(4, ["character:a-imgs:2", "character:b-imgs:2"])).toBe(8);
    expect(8).toBeGreaterThan(OMNI_MAX_REFERENCE_IMAGES);
  });

  it("treats suffix-less characters as one image each", () => {
    expect(totalOmniReferenceImages(2, ["character:a", "character:b"])).toBe(4);
  });
});
