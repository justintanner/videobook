import { describe, expect, it } from "vitest";
import {
  OMNI_MAX_REFERENCE_SLOTS,
  OMNI_V2V_MAX_REFERENCE_SLOTS,
  stripRefMentions,
  totalOmniReferenceSlots,
  characterRefImageCount,
  totalImageReferenceSlots,
  rewriteImageRefMentions,
  replaceHappyHorseAssetMentions,
  rewriteImageRefMentionsToBrackets,
  rewriteSeedanceAssetMentions,
  replaceNaturalAssetMentions,
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

describe("rewriteImageRefMentions", () => {
  it("rewrites @slug to the positional @referenceImage_N marker", () => {
    expect(rewriteImageRefMentions("fade-in to @img-da-set slowly", ["img-da-set"]))
      .toBe("fade-in to @referenceImage_1 slowly");
  });

  it("numbers markers by image_refs position, tolerating @-prefixed slugs", () => {
    expect(rewriteImageRefMentions("@img-b then @img-a", ["@img-a", "@img-b"]))
      .toBe("@referenceImage_2 then @referenceImage_1");
  });

  it("does not rewrite a slug inside a longer slug mention", () => {
    expect(rewriteImageRefMentions("@img-da-set and @img-da", ["img-da", "img-da-set"]))
      .toBe("@referenceImage_2 and @referenceImage_1");
  });

  it("leaves unrelated mentions and plain text alone", () => {
    expect(rewriteImageRefMentions("@character_1 waves at @img-x", ["img-y"]))
      .toBe("@character_1 waves at @img-x");
  });

  it("accepts a custom marker", () => {
    expect(rewriteImageRefMentions("@img-a", ["img-a"], "reference"))
      .toBe("@reference_1");
  });
});

describe("stripRefMentions", () => {
  it("removes clip mentions, which have no inline marker form", () => {
    expect(stripRefMentions("zoom into @vid-motion suddenly", ["@vid-motion"]))
      .toBe("zoom into suddenly");
  });

  it("removes a mention at the start of the prompt", () => {
    expect(stripRefMentions("@vid-motion but slower", ["vid-motion"]))
      .toBe(" but slower");
  });

  it("keeps mentions of other slugs", () => {
    expect(stripRefMentions("keep @img-ref here", ["vid-motion"]))
      .toBe("keep @img-ref here");
  });
});

describe("replaceHappyHorseAssetMentions", () => {
  it("rewrites @<image-slug> to a positional noun phrase by array order", () => {
    expect(replaceHappyHorseAssetMentions(
      "the character in @img-a and @img-b are fighting",
      null,
      ["img-a", "img-b"],
    )).toBe("the character in reference image 1 and reference image 2 are fighting");
  });

  it("numbers noun phrases by imageRefs position, tolerating @-prefixed slugs", () => {
    expect(replaceHappyHorseAssetMentions(
      "@img-b then @img-a",
      null,
      ["@img-a", "@img-b"],
    )).toBe("reference image 2 then reference image 1");
  });

  it("does not rewrite a slug inside a longer slug mention", () => {
    expect(replaceHappyHorseAssetMentions(
      "@img-da-set and @img-da",
      null,
      ["img-da", "img-da-set"],
    )).toBe("reference image 2 and reference image 1");
  });

  it("rewrites @<video-slug> to 'the source video' (no inline marker for the clip)", () => {
    expect(replaceHappyHorseAssetMentions(
      "Make @vid-scene-1 more cinematic",
      "vid-scene-1",
      [],
    )).toBe("Make the source video more cinematic");
  });

  it("handles both the video and image mentions in one prompt", () => {
    expect(replaceHappyHorseAssetMentions(
      "Make @vid-scene-1 look like @img-character",
      "vid-scene-1",
      ["img-character"],
    )).toBe("Make the source video look like reference image 1");
  });

  it("leaves unrelated @-mentions alone", () => {
    expect(replaceHappyHorseAssetMentions(
      "@character_1 waves at @img-x",
      "vid-other",
      ["img-y"],
    )).toBe("@character_1 waves at @img-x");
  });

  it("does not touch already-canonical [Image N] markers from the 1.1 endpoints", () => {
    // happyhorse/video-edit (1.0) has no inline marker syntax, so the helper
    // never produces "[Image N]" — but it must not corrupt one if the user
    // typed it verbatim, since the model treats it as ordinary text.
    expect(replaceHappyHorseAssetMentions(
      "Make [Image 1] wave at the camera",
      null,
      ["img-char"],
    )).toBe("Make [Image 1] wave at the camera");
  });

  it("preserves descriptive context the user typed around the mention", () => {
    expect(replaceHappyHorseAssetMentions(
      "the woman in a red qipao in @img-char waves",
      null,
      ["img-char"],
    )).toBe("the woman in a red qipao in reference image 1 waves");
  });
});

describe("rewriteImageRefMentionsToBrackets", () => {
  it("rewrites confirmed @img-* to [Image N] for HappyHorse 1.1", () => {
    expect(rewriteImageRefMentionsToBrackets(
      "the woman in a red qipao in @img-char waves",
      ["img-char", "img-other"],
    )).toBe("the woman in a red qipao in [Image 1] waves");
  });

  it("numbers by image_refs order", () => {
    expect(rewriteImageRefMentionsToBrackets(
      "@img-b then @img-a",
      ["@img-a", "@img-b"],
    )).toBe("[Image 2] then [Image 1]");
  });

  it("leaves unconfirmed @tokens alone", () => {
    expect(rewriteImageRefMentionsToBrackets("@notify @img-x", ["img-y"]))
      .toBe("@notify @img-x");
  });
});

describe("rewriteSeedanceAssetMentions", () => {
  it("rewrites image/video/audio slugs to @ImageN/@VideoN/@AudioN", () => {
    expect(rewriteSeedanceAssetMentions(
      "put @img-hero into @vid-clip with @aud-score",
      {
        imageRefs: ["img-hero"],
        videoRefs: ["vid-clip"],
        audioRefs: ["aud-score"],
      },
    )).toBe("put @Image1 into @Video1 with @Audio1");
  });

  it("numbers by array position", () => {
    expect(rewriteSeedanceAssetMentions(
      "@img-b then @img-a",
      { imageRefs: ["@img-a", "@img-b"] },
    )).toBe("@Image2 then @Image1");
  });
});

describe("replaceNaturalAssetMentions", () => {
  it("rewrites multi-ref videos and images", () => {
    expect(replaceNaturalAssetMentions(
      "blend @vid-a with @vid-b using @img-style",
      {
        videoRefs: ["vid-a", "vid-b"],
        imageRefs: ["img-style"],
      },
    )).toBe("blend reference video 1 with reference video 2 using reference image 1");
  });

  it("uses 'the source video' for a single video slug list", () => {
    expect(replaceNaturalAssetMentions(
      "edit @vid-clip",
      { videoRefs: ["vid-clip"] },
    )).toBe("edit the source video");
  });
});
