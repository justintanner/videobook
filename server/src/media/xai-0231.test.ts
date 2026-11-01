import { describe, expect, it } from "vitest";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";

const FRAME = "https://example.test/first.png";
const LAST = "https://example.test/last.png";

function request(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function refused(id: string, call: WireRequestInput): string {
  const built = buildWireRequest(resolveModel(id), call);
  return built.ok ? "" : built.error;
}

describe("xAI 0.23.1 video and image requests", () => {
  it("keeps grok-imagine-video at 720p and seven references now that the shared schema offers 1080p and fourteen", () => {
    expect(request("xai:grok-imagine-video", { prompt: "go" })).toMatchObject({ resolution: "720p" });
    expect(resolveModel("xai:grok-imagine-video").slots.find((slot) => slot.role === "image")?.max).toBe(7);
    expect(resolveModel("xai:grok-imagine-video").slots.map((slot) => slot.role)).not.toContain("last_frame");
  });

  it("pins grok-imagine-video-1.5 frames and caps its references at 720p", () => {
    expect(request("xai:grok-imagine-video-1.5", { prompt: "go", refUrls: { first_frame: [FRAME], last_frame: [LAST] } })).toMatchObject({
      model: "grok-imagine-video-1.5",
      resolution: "1080p",
      image: { url: FRAME },
      last_frame: { url: LAST },
    });
    expect(request("xai:grok-imagine-video-1.5", { prompt: "go", mode: "r2v", refUrls: { image: [FRAME] } })).toMatchObject({ resolution: "720p", duration: 10 });
    expect(resolveModel("xai:grok-imagine-video-1.5").slots.find((slot) => slot.role === "image")?.max).toBe(14);
  });

  it("offers grok-imagine-video-1.5-lite text and first-frame video only", () => {
    expect(resolveModel("xai:grok-imagine-video-1.5-lite").slots.map((slot) => slot.role)).toEqual(["first_frame"]);
    expect(request("xai:grok-imagine-video-1.5-lite", { refUrls: { first_frame: [FRAME] }, prompt: "go" })).toMatchObject({
      model: "grok-imagine-video-1.5-lite",
      image: { url: FRAME },
    });
    expect(refused("xai:grok-imagine-video-1.5-lite", { prompt: "go", mode: "r2v" })).toMatch(/has no mode r2v/u);
  });

  it("prices grok-imagine-image-2.0 generations and edits from @apicity/cost", async () => {
    const model = resolveModel("xai:grok-imagine-image-2.0");
    const generated = await estimateGeneration(model, { prompt: "a kite" });
    const edited = await estimateGeneration(model, { prompt: "make it blue", refUrls: { image: [FRAME] } });
    expect(generated.ok && generated.estimate).toMatchObject({ usd: expect.closeTo(0.08, 6), warnings: [] });
    expect(edited.ok && edited.estimate).toMatchObject({ usd: expect.closeTo(0.09, 6), warnings: [] });
    expect(refused("xai:grok-imagine-image-2.0", { prompt: "x", refUrls: { image: Array.from({ length: 6 }, () => FRAME) } })).toMatch(/at most 5/u);
  });
});
