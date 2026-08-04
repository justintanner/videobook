import { describe, expect, it } from "vitest";
import {
  assertNoUnresolvedMentions,
  assertProviderPayload,
  ProviderMentionError,
  transformProviderPrompt,
  unresolvedProviderMentions,
} from "./provider-prompt-transform.js";

describe("provider prompt transforms", () => {
  it("rewrites Kling motion-control media by provider array order", () => {
    expect(transformProviderPrompt(
      "generate_kie_kling_3_0_motion_control",
      {
        prompt: "motion @vid-one, look @img-one",
        character_image_slugs: ["img-one"],
        motion_video_slugs: ["vid-one"],
      },
    )).toBe("motion the source video, look reference image 1");
    expect(transformProviderPrompt(
      "generate_kie_kling_3_0_motion_control",
      {
        prompt: "blend @vid-one and @vid-two",
        motion_video_slugs: ["vid-one", "vid-two"],
      },
    )).toBe("blend reference video 1 and reference video 2");
  });

  it("uses provider-native markers where supported", () => {
    expect(transformProviderPrompt(
      "generate_kie_seedance_2_0_mini_video",
      {
        prompt: "@img-one follows @vid-one with @aud-one",
        image_slugs: ["img-one"],
        video_slugs: ["vid-one"],
        audio_slugs: ["aud-one"],
      },
    )).toBe("@Image1 follows @Video1 with @Audio1");
    expect(transformProviderPrompt(
      "generate_google_flow_nano_banana_pro_image",
      { prompt: "paint @img-one", image_slugs: ["img-one"] },
    )).toBe("paint @reference_1");
  });

  it("rejects unresolved grid and local asset mentions", () => {
    expect(unresolvedProviderMentions(
      "@a2 @img-local @element_1 @referenceImage_1 @Image1 @image1",
    )).toEqual(["@a2", "@img-local"]);
    expect(unresolvedProviderMentions(
      "keep @scene-set-01 with @prompt-intro_v2 and @script-final",
    )).toEqual(["@scene-set-01", "@prompt-intro_v2", "@script-final"]);
    expect(() => assertNoUnresolvedMentions("use @vid-local", {
      toolName: "example_tool",
    })).toThrow(ProviderMentionError);
    expect(() => assertProviderPayload(
      { input: { prompt: "use @a2" } },
      { toolName: "generate_kie_kling_3_0_video" },
    )).toThrow("@a2");
  });

  it("rejects preview placeholder URLs only at the wire boundary", () => {
    const payload = {
      input: {
        prompt: "use @Image1",
        image_urls: ["http://url.resolved.later.for/img-one"],
      },
    };
    expect(() => assertProviderPayload(payload, {
      toolName: "preview",
    })).not.toThrow();
    expect(() => assertProviderPayload(payload, {
      toolName: "wire",
      wire: true,
    })).toThrow("placeholder");
  });
});
