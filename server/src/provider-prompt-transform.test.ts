import { describe, expect, it } from "vitest";
import {
  assertNoUnresolvedMentions,
  assertProviderPayload,
  ProviderMentionError,
  transformProviderPrompt,
  unresolvedProviderMentions,
} from "./provider-prompt-transform.js";

const IMG_ID = "01890f1c-0000-7000-8000-0000000000aa";
const VID_ID = "01890f1c-0000-7000-8000-0000000000bb";
const VID_ID_2 = "01890f1c-0000-7000-8000-0000000000cc";
const AUD_ID = "01890f1c-0000-7000-8000-0000000000dd";

describe("provider prompt transforms", () => {
  it("rewrites Kling motion-control media by provider array order", () => {
    expect(transformProviderPrompt(
      "generate_kie_kling_3_0_motion_control",
      {
        prompt: `motion @${VID_ID}, look @${IMG_ID}`,
        character_image_refs: [IMG_ID],
        motion_video_refs: [VID_ID],
      },
    )).toBe("motion the source video, look reference image 1");
    expect(transformProviderPrompt(
      "generate_kie_kling_3_0_motion_control",
      {
        prompt: `blend @${VID_ID} and @${VID_ID_2}`,
        motion_video_refs: [VID_ID, VID_ID_2],
      },
    )).toBe("blend reference video 1 and reference video 2");
  });

  it("uses provider-native markers where supported", () => {
    expect(transformProviderPrompt(
      "generate_kie_seedance_2_0_mini_video",
      {
        prompt: `@${IMG_ID} follows @${VID_ID} with @${AUD_ID}`,
        image_refs: [IMG_ID],
        video_refs: [VID_ID],
        audio_refs: [AUD_ID],
      },
    )).toBe("@Image1 follows @Video1 with @Audio1");
    expect(transformProviderPrompt(
      "generate_google_flow_nano_banana_pro_image",
      { prompt: `paint @${IMG_ID}`, image_refs: [IMG_ID] },
    )).toBe("paint @reference_1");
  });

  it("naturalizes MiniMax H3 references and drops its frame mentions", () => {
    expect(transformProviderPrompt(
      "generate_kie_minimax_h3_reference_to_video",
      {
        prompt: `kitten @${IMG_ID}, motion from @${VID_ID}`,
        image_refs: [IMG_ID],
        video_refs: [VID_ID],
        audio_refs: [AUD_ID],
      },
    )).toBe("kitten reference image 1, motion from the source video");
    expect(transformProviderPrompt(
      "generate_kie_minimax_h3_image_to_video",
      {
        prompt: `pan across @${IMG_ID}`,
        first_frame_ref: IMG_ID,
      },
    )).toBe("pan across");
  });

  it("rejects unresolved grid and artifact-id mentions", () => {
    expect(unresolvedProviderMentions(
      `@a2 @${IMG_ID} @element_1 @referenceImage_1 @Image1 @image1`,
    )).toEqual(["@a2", `@${IMG_ID}`]);
    expect(unresolvedProviderMentions(
      "keep @some-handle and plain @words alone",
    )).toEqual([]);
    expect(() => assertNoUnresolvedMentions(`use @${VID_ID}`, {
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
        image_urls: [`http://url.resolved.later.for/${IMG_ID}`],
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
