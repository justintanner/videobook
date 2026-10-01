import { describe, expect, it } from "vitest";
import {
  FalAlibabaQwenImage3EditRequestSchema,
  FalNanoBananaProEditRequestSchema,
  FalWanV2p7EditRequestSchema,
} from "@apicity/fal/zod";
import {
  GptImage2ImageToImageRequestSchema,
  SeedreamProImageToImageRequestSchema,
} from "@apicity/kie/zod";
import {
  downloadResultImages,
  GROK_EXACT_MASK_ADAPTER_ID,
  IMAGE_EDIT_ADAPTERS,
  imageEditAdapter,
  seedreamRegionReplacementRequest,
  type ImageEditAdapter,
  type ImageEditProviderRequest,
} from "./_image-edit-adapter.js";
import { findImageEditModel } from "../image-edit-models.js";

const SOURCE = "https://example.test/source.png";
const REPLACEMENTS = [
  "https://example.test/replacement-1.png",
  "https://example.test/replacement-2.png",
];

function semanticInput(prompt = "Make the sky sunset orange") {
  return {
    imageUrls: [SOURCE],
    prompt,
    width: 1920,
    height: 1080,
  };
}

function regionInput() {
  return {
    imageUrls: [SOURCE, ...REPLACEMENTS],
    prompt: "Replace the two marked regions with the reference identities",
    width: 1080,
    height: 1920,
  };
}

function storedShape(adapter: ImageEditAdapter, request: ImageEditProviderRequest): unknown {
  const model = findImageEditModel(adapter.id);
  expect(model, `catalog entry missing for adapter ${adapter.id}`).toBeDefined();
  return model!.provider === "fal"
    ? { endpoint_id: adapter.id, input: request.input }
    : request;
}

function catalogSchemaParse(adapter: ImageEditAdapter, stored: unknown): boolean {
  const model = findImageEditModel(adapter.id)!;
  const payload = model.provider === "fal"
    ? (stored as { input: unknown }).input
    : stored;
  return model.requestSchema.safeParse(payload).success;
}

function imageUrlsOf(request: ImageEditProviderRequest): unknown {
  return request.input.image_urls ?? request.input.input_urls;
}

describe("image edit adapters", () => {
  it("exposes one adapter per catalog model with matching ids", () => {
    expect(IMAGE_EDIT_ADAPTERS.length).toBe(8);
    for (const adapter of IMAGE_EDIT_ADAPTERS) {
      expect(findImageEditModel(adapter.id), adapter.id).toBeDefined();
    }
    expect(imageEditAdapter("seedream/5-pro-image-to-image")?.id).toBe("seedream/5-pro-image-to-image");
    expect(imageEditAdapter("does-not-exist")).toBeUndefined();
  });

  for (const adapter of IMAGE_EDIT_ADAPTERS) {
    it(`${adapter.id}: semantic build sends source only and region build sends base plus refs`, () => {
      const semantic = adapter.buildSemanticRequest(semanticInput());
      expect(semantic.model).toBe(adapter.id);
      expect(imageUrlsOf(semantic)).toEqual([SOURCE]);

      const region = adapter.buildRegionRequest(regionInput());
      expect(imageUrlsOf(region)).toEqual([SOURCE, ...REPLACEMENTS]);
    });

    it(`${adapter.id}: built requests parse against the catalog schema and round-trip stored payloads`, () => {
      for (const request of [
        adapter.buildSemanticRequest(semanticInput()),
        adapter.buildRegionRequest(regionInput()),
      ]) {
        const stored = storedShape(adapter, request);
        expect(catalogSchemaParse(adapter, stored), JSON.stringify(stored)).toBe(true);
        const recognized = adapter.parseStoredPayload(stored);
        expect(recognized, adapter.id).not.toBeNull();
        expect(recognized!.model).toBe(adapter.id);
        expect(recognized!.input).toEqual(request.input);
      }
    });

    it(`${adapter.id}: rejects stored payloads from other adapters`, () => {
      const foreign = IMAGE_EDIT_ADAPTERS.find((candidate) => candidate.id !== adapter.id)!;
      const foreignRequest = foreign.buildSemanticRequest(semanticInput());
      const foreignStored = storedShape(foreign, foreignRequest);
      expect(adapter.parseStoredPayload(foreignStored)).toBeNull();
      expect(adapter.parseStoredPayload(null)).toBeNull();
      expect(adapter.parseStoredPayload("https://example.test")).toBeNull();
    });
  }

  it("maps aspect ratio from source dimensions", () => {
    const seedream = imageEditAdapter("seedream/5-pro-image-to-image")!;
    expect(seedream.buildSemanticRequest(semanticInput()).input.aspect_ratio).toBe("16:9");
    expect(seedream.buildSemanticRequest({
      imageUrls: [SOURCE],
      prompt: "portrait",
      width: 1080,
      height: 1920,
    }).input.aspect_ratio).toBe("9:16");
    const gptPortrait = imageEditAdapter("gpt-image-2-image-to-image")!
      .buildSemanticRequest(semanticInput("portrait"));
    expect(gptPortrait.input.aspect_ratio).toBe("16:9");
  });

  it("enforces the gpt-image-2 16-image input cap before submit", () => {
    const adapter = imageEditAdapter("gpt-image-2-image-to-image")!;
    const urls = [SOURCE, ...Array.from({ length: 15 }, (_, i) => `https://example.test/${i}.png`)];
    expect(() => adapter.buildRegionRequest({
      imageUrls: urls,
      prompt: "cap edge",
      width: 1000,
      height: 1000,
    })).not.toThrow();
    expect(() => adapter.buildRegionRequest({
      imageUrls: [...urls, "https://example.test/over.png"],
      prompt: "over cap",
      width: 1000,
      height: 1000,
    })).toThrow();
  });

  it("enforces the qwen 3 reference cap of three inputs", () => {
    const adapter = imageEditAdapter("alibaba/qwen-image-3/edit")!;
    expect(() => adapter.buildRegionRequest(regionInput())).not.toThrow();
    expect(() => adapter.buildRegionRequest({
      imageUrls: [SOURCE, ...REPLACEMENTS, "https://example.test/replacement-3.png"],
      prompt: "over reference cap",
      width: 1000,
      height: 1000,
    })).toThrow();
  });

  it("rejects wan 2.7 prompts beyond 500 characters before submit", () => {
    const adapter = imageEditAdapter("fal-ai/wan/v2.7/edit")!;
    expect(() => adapter.buildSemanticRequest(semanticInput("a".repeat(500)))).not.toThrow();
    expect(() => adapter.buildSemanticRequest(semanticInput("a".repeat(501)))).toThrow(/500 characters/);
  });

  it("keeps the grok exact-mask route outside the swappable registry", () => {
    expect(GROK_EXACT_MASK_ADAPTER_ID).toBe("grok-imagine-image-2-0/image-edit");
    expect(imageEditAdapter(GROK_EXACT_MASK_ADAPTER_ID)).toBeUndefined();
  });

  it("keeps the seedream region builder stable for callers", () => {
    const request = seedreamRegionReplacementRequest(regionInput());
    const parsed = SeedreamProImageToImageRequestSchema.parse({
      model: request.model,
      input: request.input,
    });
    expect(parsed.input.image_urls).toEqual([SOURCE, ...REPLACEMENTS]);
    expect(parsed.input.quality).toBe("basic");
  });

  it("normalizes downloaded result images to png buffers", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const blobs = [png, png];
    const urls = blobs.map((_, index) => URL.createObjectURL(new Blob([blobs[index]!], { type: "image/png" })));
    try {
      const images = await downloadResultImages(urls, new AbortController().signal, "test");
      expect(images).toHaveLength(2);
      for (const image of images) {
        const metadata = await import("sharp").then((sharp) => sharp.default(image).metadata());
        expect(metadata.format).toBe("png");
        expect(metadata.width).toBe(1);
      }
    } finally {
      for (const url of urls) URL.revokeObjectURL(url);
    }
  });

  it("validates fal input schemas directly for each fal endpoint", () => {
    expect(FalNanoBananaProEditRequestSchema.safeParse({
      prompt: "x",
      image_urls: [SOURCE],
    }).success).toBe(true);
    expect(FalAlibabaQwenImage3EditRequestSchema.safeParse({
      prompt: "x",
      image_urls: [SOURCE],
    }).success).toBe(true);
    expect(FalWanV2p7EditRequestSchema.safeParse({
      prompt: "x",
      image_urls: [SOURCE],
    }).success).toBe(true);
    expect(FalWanV2p7EditRequestSchema.safeParse({
      prompt: "x".repeat(501),
      image_urls: [SOURCE],
    }).success).toBe(false);
    expect(GptImage2ImageToImageRequestSchema.safeParse({
      model: "gpt-image-2-image-to-image",
      input: { prompt: "x", input_urls: [SOURCE], aspect_ratio: "auto" },
    }).success).toBe(true);
  });
});
