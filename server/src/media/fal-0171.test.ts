import { describe, expect, it } from "vitest";
import { FAL_ENDPOINT_REQUEST_SCHEMAS } from "@apicity/fal/zod";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import type { MediaRefs, Operation } from "./types.js";

const image = "https://example.com/image.png";
const video = "https://example.com/video.mp4";
const cases: [string, Operation, MediaRefs][] = [
  ["kling/v4/text-to-video", "text_to_video", {}],
  ["kling/v4/image-to-video", "image_to_video", { first_frame: [image] }],
  ["kling/v4/reference-to-video", "reference_to_video", { image: [image] }],
  ["kling/v4/video-to-video/edit", "edit_video", { video: [video] }],
  ["heygen/heygen-video/text-to-video", "text_to_video", {}],
  ["heygen/heygen-video/image-to-video", "image_to_video", { first_frame: [image] }],
  ["heygen/heygen-video/reference-to-video", "reference_to_video", { image: [image] }],
  ["fal-ai/heygen/avatar3/digital-twin", "text_to_video", {}],
  ["fal-ai/heygen/avatar4/digital-twin", "text_to_video", {}],
  ["fal-ai/heygen/avatar5/digital-twin", "text_to_video", {}],
  ["fal-ai/heygen/avatar4/image-to-video", "image_to_video", { image: [image] }],
  ["fal-ai/heygen/v2/video-agent", "text_to_video", {}],
  ["fal-ai/heygen/v3/video-agent", "text_to_video", {}],
];

describe("fal 0.17.1 video catalog", () => {
  it.each(cases)("%s accepts a prompt and required refs without extra options", (apiId, operation, refUrls) => {
    const model = resolveModel(`fal:${apiId}`);
    expect(model.entry.operations).toEqual([operation]);
    const built = buildWireRequest(model, { prompt: "Hello from the studio", refUrls });
    expect(built).toMatchObject({ ok: true });
    if (!built.ok) return;
    const schema = FAL_ENDPOINT_REQUEST_SCHEMAS[apiId as keyof typeof FAL_ENDPOINT_REQUEST_SCHEMAS];
    expect(schema.safeParse(built.request).success).toBe(true);
  });

  it.each([3, 4])("Avatar %s preserves the spoken script while changing stock avatar and voice", (version) => {
    const model = resolveModel(`fal:fal-ai/heygen/avatar${version}/digital-twin`);
    expect(buildWireRequest(model, { prompt: "Welcome" })).toMatchObject({
      ok: true, request: { character: { avatar: "Abigail Office Front" }, voice: { prompt: "Welcome", voice: "Ivy" } },
    });
    expect(buildWireRequest(model, { prompt: "Welcome", options: { avatar: "Abigail Sofa Front", voice: "Warm Pro Narrator", speed: 1.2 } }))
      .toMatchObject({ ok: true, request: { character: { avatar: "Abigail Sofa Front" }, voice: { prompt: "Welcome", voice: "Warm Pro Narrator", speed: 1.2 } } });
    expect(model.slots.map((slot) => slot.role)).toEqual(["audio"]);
  });

  it("supplies the Avatar 4 voice and retains Avatar 5 SDK defaults", () => {
    expect(buildWireRequest(resolveModel("fal:fal-ai/heygen/avatar4/image-to-video"), { prompt: "Welcome", refUrls: { image: [image] } }))
      .toMatchObject({ ok: true, request: { prompt: "Welcome", image_url: image, voice: "Ivy" } });
    expect(buildWireRequest(resolveModel("fal:fal-ai/heygen/avatar5/digital-twin"), { prompt: "Welcome" }))
      .toMatchObject({ ok: true, request: { prompt: "Welcome", avatar: "Abigail Sofa Front", voice: "Warm Pro Narrator" } });
  });

  it("requires a visual reference for HeyGen reference video", () => {
    const model = resolveModel("fal:heygen/heygen-video/reference-to-video");
    expect(buildWireRequest(model, { prompt: "Move", refUrls: { audio: ["https://example.com/audio.mp3"] } }).ok).toBe(false);
    expect(buildWireRequest(model, { prompt: "Move", refUrls: { video: [video] } }).ok).toBe(true);
  });

  it("wires Kling frames, video edits and numbered reference mentions", () => {
    expect(buildWireRequest(resolveModel("fal:kling/v4/image-to-video"), {
      prompt: "Move", refUrls: { first_frame: [image], last_frame: [image] },
    })).toMatchObject({ ok: true, request: { start_image_url: image, end_image_url: image, duration: 12, resolution: "1080p" } });
    const model = resolveModel("fal:kling/v4/video-to-video/edit");
    expect(buildWireRequest(model, { prompt: "Edit" }).ok).toBe(false);
    expect(buildWireRequest(model, { prompt: "Edit", refUrls: { video: [video], image: [image] } }))
      .toMatchObject({ ok: true, request: { video_url: video, image_urls: [image] } });
    expect(applyPromptDialect(model.entry.dialect, "Use @image1 in @video1", {
      image: ["0198c2a0-0000-7000-8000-000000000001"], video: ["0198c2a0-0000-7000-8000-000000000002"],
    })).toBe("Use @Image1 in @Video1");
  });

  it("prices Kling multi-shot output by summed shot duration", async () => {
    const model = resolveModel("fal:kling/v4/text-to-video");
    const result = await estimateGeneration(model, { options: { multi_prompt: [{ prompt: "One", duration: 3 }, { prompt: "Two", duration: 7 }] } });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.estimate.usd).toBeCloseTo(10 * 0.235);
  });
});
