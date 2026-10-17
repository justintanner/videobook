import { describe, expect, it } from "vitest";
import { modelEntry } from "./catalog.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import type { MediaRefs } from "./types.js";

const IMG_ID = "01890f1c-0000-7000-8000-0000000000aa";
const VID_ID = "01890f1c-0000-7000-8000-0000000000bb";
const VID_ID_2 = "01890f1c-0000-7000-8000-0000000000cc";
const AUD_ID = "01890f1c-0000-7000-8000-0000000000dd";

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
    expect(forModel(
      "googleflow:nano-banana-pro",
      `paint @${IMG_ID}`,
      { image: [IMG_ID] },
    )).toBe("paint @reference_1");
    expect(applyPromptDialect("brackets", "hero @image1 waves", { image: [IMG_ID] }))
      .toBe("hero [Image 1] waves");
    expect(forModel(
      "fal:fal-ai/vidu/q4/reference-to-video",
      `@${IMG_ID} sings along to @${AUD_ID}`,
      { image: [IMG_ID], audio: [AUD_ID] },
    )).toBe("[@reference_image_1] sings along to [reference_audio_1]");
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
      .toBe(`hero @${IMG_ID} waves`);
  });

  it("leaves unmatched slots and URL refs untouched", () => {
    expect(applyPromptDialect(undefined, "hero @image3 waves", { image: [IMG_ID] }))
      .toBe("hero @image3 waves");
    expect(applyPromptDialect("natural", "hero @image1 waves", { image: ["https://example.test/a.png"] }))
      .toBe("hero @image1 waves");
  });
});
