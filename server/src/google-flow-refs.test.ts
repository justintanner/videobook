import { describe, expect, it } from "vitest";
import {
  OMNI_MAX_REFERENCE_SLOTS,
  OMNI_V2V_MAX_REFERENCE_SLOTS,
  stripSlugMentions,
  totalOmniReferenceSlots,
  characterRefImageCount,
  totalImageReferenceSlots,
  rewriteImageSlugMentions,
} from "./google-flow-refs.js";

describe("totalOmniReferenceSlots", () => {
  it("charges a flat 2 slots per character regardless of -imgs:N", () => {
    expect(totalOmniReferenceSlots(0, ["character:a-imgs:1"])).toBe(2);
    expect(totalOmniReferenceSlots(0, ["character:a-imgs:2"])).toBe(2);
    expect(totalOmniReferenceSlots(0, ["character:a"])).toBe(2);
  });

  it("fits 3 characters + 1 image exactly in the 7-slot R2V budget", () => {
    expect(totalOmniReferenceSlots(1, ["character:a-imgs:1", "character:b-imgs:1", "character:c-imgs:1"]))
      .toBe(OMNI_MAX_REFERENCE_SLOTS);
  });

  it("overflows with 4 characters + 1 image (the observed INVALID_ARGUMENT 400)", () => {
    expect(totalOmniReferenceSlots(1, ["character:a-imgs:1", "character:b-imgs:1", "character:c-imgs:1", "character:d-imgs:1"]))
      .toBe(9);
    expect(9).toBeGreaterThan(OMNI_MAX_REFERENCE_SLOTS);
  });

  it("overflows with 4 characters even without images", () => {
    expect(totalOmniReferenceSlots(0, ["character:a", "character:b", "character:c", "character:d"]))
      .toBeGreaterThan(OMNI_MAX_REFERENCE_SLOTS);
  });

  it("fits 2 characters + 1 image exactly in the 5-slot V2V budget", () => {
    expect(totalOmniReferenceSlots(1, ["character:a-imgs:1", "character:b-imgs:2"]))
      .toBe(OMNI_V2V_MAX_REFERENCE_SLOTS);
  });
});

describe("characterRefImageCount & totalImageReferenceSlots", () => {
  it("characterRefImageCount parses -imgs:N or defaults to 1", () => {
    expect(characterRefImageCount("character:foo-imgs:3")).toBe(3);
    expect(characterRefImageCount("character:bar")).toBe(1);
  });

  it("totalImageReferenceSlots sums raw image count and character counts", () => {
    expect(totalImageReferenceSlots(2, ["character:a-imgs:2", "character:b"])).toBe(5);
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

  it("accepts a custom marker", () => {
    expect(rewriteImageSlugMentions("@img-a", ["img-a"], "reference"))
      .toBe("@reference_1");
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
