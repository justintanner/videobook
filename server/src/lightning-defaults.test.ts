import { describe, expect, it } from "vitest";
import { resolveModel } from "./media/descriptor.js";
import {
  finishingIdentityKey,
  freshPostLanguage,
  freshPostTags,
  LIGHTNING_SCENE_MODEL,
  LIGHTNING_VIDEO_MODEL,
  LIGHTNING_WATERMARK_PROFILE,
  preservedPrompt,
  submittedGenerationPrompt,
  suggestedColdOpen,
  watermarkProfileFor,
  watermarkWindowsFor,
  X_WATERMARK_PROFILE,
} from "./lightning-defaults.js";

describe("lightning defaults", () => {
  function defaults(model: string): Record<string, unknown> {
    return Object.fromEntries(resolveModel(model).options.map((option) => [option.name, option.defaultValue]));
  }

  it("defaults the Seedance 2.5 catalog model to the lightning video profile", () => {
    expect(defaults(LIGHTNING_VIDEO_MODEL)).toMatchObject({
      resolution: "1080p",
      aspect_ratio: "9:16",
      duration: 12,
      output_format: "mp4",
      generate_audio: true,
    });
  });

  it("defaults the Nano Banana 2.1 catalog model to the lightning scene profile", () => {
    expect(defaults(LIGHTNING_SCENE_MODEL)).toMatchObject({
      aspect_ratio: "9:16",
      resolution: "4K",
      output_format: "jpg",
    });
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
    expect(base).not.toContain("qrStartSeconds");
    expect(finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 0,
      endSeconds: 2.3,
      profile,
      qrStartSeconds: null,
      qrEndSeconds: null,
    })).toBe(base);
    expect(finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 0,
      endSeconds: 2.3,
      profile: { ...profile, qrStartSeconds: null, qrEndSeconds: null },
    })).toBe(base);
    const qrWindow = finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 0,
      endSeconds: 2.3,
      profile,
      qrStartSeconds: 1.2,
      qrEndSeconds: 3.5,
    });
    expect(qrWindow).not.toBe(base);
    expect(finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 0,
      endSeconds: 2.3,
      profile: { ...profile, qrStartSeconds: 1.2, qrEndSeconds: 3.5 },
    })).toBe(qrWindow);
    expect(finishingIdentityKey({
      sourceObjectHash: "abc",
      startSeconds: 0,
      endSeconds: 2.3,
      profile,
      qrStartSeconds: 1.2,
      qrEndSeconds: 4,
    })).not.toBe(qrWindow);
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
