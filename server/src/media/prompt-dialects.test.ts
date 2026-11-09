import { describe, expect, it } from "vitest";
import { modelEntry } from "./catalog.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import type { MediaRefs } from "./types.js";

const IMG_ID = "01890f1c-0000-7000-8000-0000000000aa";
const VID_ID = "01890f1c-0000-7000-8000-0000000000bb";
const VID_ID_2 = "01890f1c-0000-7000-8000-0000000000cc";
const AUD_ID = "01890f1c-0000-7000-8000-0000000000dd";
const IMG_ID_2 = "01890f1c-0000-7000-8000-0000000000ee";

function forModel(model: string, prompt: string, refs: MediaRefs): string {
  const entry = modelEntry(model);
  if (!entry) throw new Error(`missing catalog entry ${model}`);
  return applyPromptDialect(entry.dialect, prompt, refs);
}

describe("prompt dialects", () => {
  it("rewrites Kling motion-control media by provider array order", () => {
    expect(forModel(
      "kie:kling-3.0/motion-control",
      `motion @${VID_ID}, look @${IMG_ID}`,
      { image: [IMG_ID], video: [VID_ID] },
    )).toBe("motion the source video, look reference image 1");
    expect(forModel(
      "kie:kling-3.0/motion-control",
      `blend @${VID_ID} and @${VID_ID_2}`,
      { video: [VID_ID, VID_ID_2] },
    )).toBe("blend reference video 1 and reference video 2");
  });

  it("uses provider-native markers where supported", () => {
    expect(forModel(
      "kie:bytedance/seedance-2-5",
      `@${IMG_ID} follows @${VID_ID} with @${AUD_ID}`,
      { image: [IMG_ID], video: [VID_ID], audio: [AUD_ID] },
    )).toBe("@Image1 follows @Video1 with @Audio1");
    expect(applyPromptDialect("brackets", "hero @image1 waves", { image: [IMG_ID] }))
      .toBe("hero [Image 1] waves");
    expect(forModel(
      "fal:fal-ai/vidu/q4/reference-to-video",
      `@${IMG_ID} sings along to @${AUD_ID}`,
      { image: [IMG_ID], audio: [AUD_ID] },
    )).toBe("[@reference_image_1] sings along to [reference_audio_1]");
  });

  it("binds Gemini Omni, Grok 1.5 and Kling o3 references with each host's documented markers", () => {
    const refs = { image: [IMG_ID, IMG_ID_2], video: [VID_ID] };
    const prompt = "dress @video1 like @image2 and @image1";
    for (const model of ["fal:google/gemini-omni-flash/v1.1/reference-to-video", "wavespeed:google/gemini-omni-1.1-flash/reference-to-video"]) {
      expect(forModel(model, prompt, refs), model).toBe("dress <VIDEO_REF_0> like <IMAGE_REF_1> and <IMAGE_REF_0>");
    }
    expect(forModel("fal:google/gemini-omni-flash/reference-to-video", "@image1 waves", { image: [IMG_ID] })).toBe("<IMAGE_REF_0> waves");
    for (const model of ["fal:xai/grok-imagine-video/v1.5/reference-to-video", "wavespeed:x-ai/grok-imagine-video-v1.5/reference-to-video", "xai:grok-imagine-video-1.5"]) {
      expect(forModel(model, "@image2 hands @image1 a flower", { image: [IMG_ID, IMG_ID_2] }), model).toBe("<IMAGE_1> hands <IMAGE_0> a flower");
    }
    expect(forModel("xai:grok-imagine-video-1.5", "@firstframe to @lastframe", { first_frame: [IMG_ID], last_frame: [IMG_ID_2] }))
      .toBe("the first frame to the last frame");
    expect(forModel("xai:grok-imagine-video-1.5", "@video1 at night", { video: [VID_ID] })).toBe("the source video at night");
    expect(forModel("wavespeed:kwaivgi/kling-video-o3-pro/video-edit", prompt, refs)).toBe("dress <<<video_1>>> like <<<image_2>>> and <<<image_1>>>");
    for (const model of ["fal:fal-ai/kling-video/o3/pro/video-to-video/edit", "fal:fal-ai/kling-video/o3/pro/video-to-video/reference"]) {
      expect(forModel(model, prompt, refs), model).toBe("dress @Video1 like @Image2 and @Image1");
    }
    for (const model of ["fal:fal-ai/kling-video/o3/pro/reference-to-video", "fal:fal-ai/kling-video/o3/4k/reference-to-video"]) {
      expect(forModel(model, "@firstframe then @image1", { first_frame: [VID_ID], image: [IMG_ID] }), model).toBe("then @Image1");
    }
  });

  it("naturalizes MiniMax H3 references and drops its frame mentions", () => {
    expect(forModel(
      "kie:minimax-h3/reference-to-video",
      `kitten @${IMG_ID}, motion from @${VID_ID}`,
      { image: [IMG_ID], video: [VID_ID], audio: [AUD_ID] },
    )).toBe("kitten reference image 1, motion from the source video");
    expect(forModel(
      "kie:minimax-h3/image-to-video",
      `pan across @${IMG_ID}`,
      { first_frame: [IMG_ID] },
    )).toBe("pan across");
  });

  it("expands slot tokens to the connected artifact before applying the dialect", () => {
    expect(applyPromptDialect(
      "natural",
      "kitten @image1 dances to @audio1 like @video1",
      { image: [IMG_ID], video: [VID_ID], audio: [AUD_ID] },
    )).toBe("kitten reference image 1 dances to reference audio 1 like the source video");
    expect(applyPromptDialect(
      "seedance",
      "@firstframe to @lastframe with @image1",
      { image: [IMG_ID], first_frame: [VID_ID], last_frame: [VID_ID_2] },
    )).toBe("to with @Image1");
    expect(applyPromptDialect("plain", "hero @image1 waves", { image: [IMG_ID] }))
      .toBe("hero reference image 1 waves");
  });

  it("never lets a connected artifact id reach the provider prompt", () => {
    const refs = { first_frame: [IMG_ID], last_frame: [VID_ID], loop: [VID_ID_2], keyframe: [AUD_ID, IMG_ID_2] };
    const prompt = "open on @firstframe, hold @keyframe1 then @keyframe2, close on @lastframe and return to @loop";
    for (const dialect of ["natural", "natural_numbered", "natural_kinds", "natural_source_video", "brackets", "vidu", "kling4", "kling_omni", "gemini_omni", "grok", "happyhorse_edit", "plain"] as const) {
      expect(applyPromptDialect(dialect, prompt, refs), dialect)
        .toBe("open on the first frame, hold keyframe 1 then keyframe 2, close on the last frame and return to the loop frame");
    }
  });

  it("leaves unmatched slots and URL refs untouched", () => {
    expect(applyPromptDialect(undefined, "hero @image3 waves", { image: [IMG_ID] }))
      .toBe("hero @image3 waves");
    expect(applyPromptDialect("natural", "hero @image1 waves", { image: ["https://example.test/a.png"] }))
      .toBe("hero @image1 waves");
  });
});
