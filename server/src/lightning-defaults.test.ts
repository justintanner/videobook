import { describe, expect, it } from "vitest";
import { getImageToolSchema } from "./image-models.js";
import {
  finishingIdentityKey,
  freshPostLanguage,
  freshPostTags,
  LIGHTNING_SCENE_MODEL_KEY,
  LIGHTNING_VIDEO_TOOL,
  LIGHTNING_WATERMARK_PROFILE,
  preservedPrompt,
  submittedGenerationPrompt,
  suggestedColdOpen,
  watermarkProfileFor,
  watermarkWindowsFor,
  X_WATERMARK_PROFILE,
} from "./lightning-defaults.js";
import { selectPreviewImageModel } from "./tools/preview-image-gen.js";
import { getVideoToolSchema } from "./video-models.js";

describe("lightning defaults", () => {
  it("fills a fresh Seedance 2.5 schema with the lightning video profile", () => {
    const schema = getVideoToolSchema(LIGHTNING_VIDEO_TOOL);
    expect(schema?.defaults).toMatchObject({
      resolution: "1080p",
      aspect_ratio: "16:9",
      duration: "13",
      output_format: "mp4",
      generate_audio: true,
    });
  });

  it("fills a fresh Nano Banana 2.1 schema with the lightning scene profile", () => {
    const schema = getImageToolSchema("generate_kie_nano_banana_2_1_image");
    expect(schema?.defaults).toMatchObject({
      aspect_ratio: "16:9",
      resolution: "2K",
      output_format: "jpg",
    });
  });

  it("keeps an explicit preview model and a compatible historical model", () => {
    const options = [
      { key: LIGHTNING_SCENE_MODEL_KEY, image_slots: { min: 0, max: 10 } },
      { key: "grok_imagine_text", image_slots: null },
    ];
    expect(selectPreviewImageModel("grok_imagine_text", null, 0, options)).toBe("grok_imagine_text");
    expect(selectPreviewImageModel(undefined, "grok_imagine_text", 0, options)).toBe("grok_imagine_text");
    expect(selectPreviewImageModel(undefined, null, 0, options)).toBe(LIGHTNING_SCENE_MODEL_KEY);
  });

  it("uses the submitted prompt and ignores a disagreeing resolved prompt", () => {
    expect(submittedGenerationPrompt({
      dispatchedPrompt: "short submitted",
      cellPrompt: "slot text",
      resolvedPrompt: "old cinematic paragraph that must not win",
    })).toBe("short submitted");
    expect(submittedGenerationPrompt({
      dispatchedPrompt: "",
      cellPrompt: "slot text",
      resolvedPrompt: "old cinematic paragraph",
    })).toBe("slot text");
    expect(submittedGenerationPrompt({
      dispatchedPrompt: "  ",
      cellPrompt: "",
      resolvedPrompt: "old cinematic paragraph",
    })).toBe("");
  });

  it("preserves authored prompts and clamps generated ones", () => {
    const long = "one two three four five";
    expect(preservedPrompt(long, 3, true)).toBe(long);
    expect(preservedPrompt(long, 3, false)).toBe("one two three");
  });

  it("suggests a 2.3 second cold open and clamps it to the clip", () => {
    expect(suggestedColdOpen(13)).toEqual({ startSeconds: 0, endSeconds: 2.3 });
    expect(suggestedColdOpen(1)).toEqual({ startSeconds: 0, endSeconds: 1 });
  });

  it("places the handle on the opening and the QR on the ending of the real duration", () => {
    expect(watermarkWindowsFor(LIGHTNING_WATERMARK_PROFILE, 13)).toEqual({
      handleStartSeconds: 0,
      handleEndSeconds: 3,
      qrStartSeconds: 10.7,
      qrEndSeconds: 13,
    });
    expect(watermarkWindowsFor(LIGHTNING_WATERMARK_PROFILE, 2)).toEqual({
      handleStartSeconds: 0,
      handleEndSeconds: 2,
      qrStartSeconds: 0,
      qrEndSeconds: 2,
    });
    expect(watermarkWindowsFor(X_WATERMARK_PROFILE, 13)).toEqual({
      handleStartSeconds: 0,
      handleEndSeconds: 13,
      qrStartSeconds: 0,
      qrEndSeconds: 13,
    });
  });

  it("lets a saved profile override lightning and keeps X isolated", () => {
    expect(watermarkProfileFor("tiktok", { handleOpacity: 0.9 }).handle).toBe("jtbkk");
    expect(watermarkProfileFor("tiktok", { handleOpacity: 0.9 }).handleOpacity).toBe(0.9);
    expect(watermarkProfileFor("x", { handle: "jtbkk" }).platform).toBe("x");
    expect(watermarkProfileFor("x", null).handle).toBe("justinwtanner");
    expect(watermarkProfileFor("x", null).handleOpacity).toBe(0.5);
  });

  it("changes finishing identity when the source, range, or profile changes", () => {
    const profile = LIGHTNING_WATERMARK_PROFILE;
    const base = finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 0,
      endSeconds: 2.3,
      profile,
    });
    expect(finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 0,
      endSeconds: 2.3,
      profile,
    })).toBe(base);
    expect(finishingIdentityKey({
      sourceObjectHash: "def",
      startSeconds: 0,
      endSeconds: 2.3,
      profile,
    })).not.toBe(base);
    expect(finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 1,
      endSeconds: 2.3,
      profile,
    })).not.toBe(base);
    expect(finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 0,
      endSeconds: 2.3,
      profile: { ...profile, handleOpacity: 0.9 },
    })).not.toBe(base);
  });

  it("uses Thai and the lightning tags only for a fresh TikTok post", () => {
    expect(freshPostLanguage("tiktok", undefined)).toBe("th");
    expect(freshPostLanguage("tiktok", "en")).toBe("en");
    expect(freshPostLanguage("x", undefined)).toBe("en");
    expect(freshPostTags("tiktok", undefined)).toEqual(["fyp", "bkk"]);
    expect(freshPostTags("tiktok", ["city"])).toEqual(["city"]);
    expect(freshPostTags("x", undefined)).toBeUndefined();
  });
});
