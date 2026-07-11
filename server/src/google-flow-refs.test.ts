import { describe, expect, it } from "vitest";
import {
  characterRefImageCount,
  OMNI_MAX_REFERENCE_IMAGES,
  rewriteImageSlugMentions,
  stripSlugMentions,
  totalOmniReferenceImages,
} from "./google-flow-refs.js";

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

describe("rewriteImageSlugMentions", () => {
  it("rewrites @slug to the positional @referenceImage_N marker", () => {
    expect(rewriteImageSlugMentions("fade-in to @img-da-set slowly", ["img-da-set"]))
      .toBe("fade-in to @referenceImage_1 slowly");
  });

  it("numbers markers by image_slugs position, tolerating @-prefixed slugs", () => {
    expect(rewriteImageSlugMentions("@img-b then @img-a", ["@img-a", "@img-b"]))
      .toBe("@referenceImage_2 then @referenceImage_1");
  });

  it("does not rewrite a slug inside a longer slug mention", () => {
    expect(rewriteImageSlugMentions("@img-da-set and @img-da", ["img-da", "img-da-set"]))
      .toBe("@referenceImage_2 and @referenceImage_1");
  });

  it("leaves unrelated mentions and plain text alone", () => {
    expect(rewriteImageSlugMentions("@character_1 waves at @img-x", ["img-y"]))
      .toBe("@character_1 waves at @img-x");
  });
});

describe("stripSlugMentions", () => {
  it("removes clip mentions, which have no inline marker form", () => {
    expect(stripSlugMentions("zoom into @vid-motion suddenly", ["@vid-motion"]))
      .toBe("zoom into suddenly");
  });

  it("removes a mention at the start of the prompt", () => {
    expect(stripSlugMentions("@vid-motion but slower", ["vid-motion"]))
      .toBe(" but slower");
  });

  it("keeps mentions of other slugs", () => {
    expect(stripSlugMentions("keep @img-ref here", ["vid-motion"]))
      .toBe("keep @img-ref here");
  });
});
