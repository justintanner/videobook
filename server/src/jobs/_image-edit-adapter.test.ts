import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { findImageEditModel } from "../image-edit-models.js";
import { resolveModel } from "../media/descriptor.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { readStoredImageSubjectEditTask } from "./image-subjects.js";

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
  if (model!.provider === "fal") return { endpoint_id: adapter.id, input: request.input };
  if (model!.provider === "kie") return request;
  return { model: adapter.id, input: request.input };
}

function catalogSchemaParse(adapter: ImageEditAdapter, stored: unknown): boolean {
  const model = findImageEditModel(adapter.id)!;
  const wire = resolveModel(model.catalogModel).wire;
  if (model.provider === "kie") return wire.request.safeParse(stored).success;
  const input = (stored as { input: unknown }).input;
  if (model.provider === "fal") return wire.request.safeParse(input).success;
  const parsed = wire.input.safeParse(input);
  return parsed.success && wire.request.safeParse(wire.wrap(parsed.data as Record<string, unknown>)).success;
}

function imageUrlsOf(request: ImageEditProviderRequest): unknown {
  return request.input.image_input ?? request.input.image_urls ?? request.input.input_urls ?? request.input.images;
}

describe("image edit adapters", () => {
  it("exposes one adapter per catalog model with matching ids", () => {
    expect(IMAGE_EDIT_ADAPTERS.length).toBe(31);
    for (const adapter of IMAGE_EDIT_ADAPTERS) {
      expect(findImageEditModel(adapter.id)?.envKey, adapter.id).toBe(adapter.envKey);
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
      if (adapter.id === "flux-3/klein-edit-image") {
        expect(semantic.input.resolution).toBe("2K");
        expect(region.input.resolution).toBe("2K");
      }
      if (adapter.id.startsWith("gpt-image-2-5-")) {
        expect(semantic.input.resolution).toBe("2K");
        expect(region.input.resolution).toBe("2K");
      }
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
    expect(() => adapter.buildSemanticRequest(semanticInput("a".repeat(501)))).toThrow("fal:fal-ai/wan/v2.7/edit prompt is 501 characters; the limit is 500");
  });

  it("keeps the grok exact-mask route outside the swappable registry", () => {
    expect(GROK_EXACT_MASK_ADAPTER_ID).toBe("grok-imagine-image-2-0/segment-edit");
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

type Route = (method: string, url: URL, body: unknown) => Response | null;

describe("catalog image edit adapters against stubbed providers", () => {
  const keys = ["WAVESPEED_API_KEY", "MACHGEN_API_KEY", "NUNCHUX_API_KEY"] as const;
  const realFetch = globalThis.fetch;
  let tempDir: string;
  let engine: Engine;
  let outputId: string;
  let calls: Array<{ method: string; url: string; body: unknown }>;
  let route: Route;
  let savedKeys: Partial<Record<(typeof keys)[number], string>>;
  let restoreEndpoints: () => void;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-catalog-edit-"));
    engine = createEngineForTest(tempDir);
    await engine.ready;
    const output = await engine.artifacts.create({ kind: "image", label: "Edit output" });
    if (!output.ok) throw new Error(output.error.message);
    outputId = output.value.artifactId;
    savedKeys = {};
    for (const key of keys) {
      if (process.env[key] !== undefined) savedKeys[key] = process.env[key];
      process.env[key] = "stub-key";
    }
    restoreEndpoints = configureProviderEndpoints({ pollIntervalMs: 1 });
    calls = [];
    route = () => null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      calls.push({ method, url: url.href, body });
      return route(method, url, body) ?? new Response("unexpected provider call", { status: 418 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    restoreEndpoints();
    for (const key of keys) {
      if (savedKeys[key] === undefined) delete process.env[key];
      else process.env[key] = savedKeys[key];
    }
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function jpeg(): Promise<Buffer> {
    return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 120, b: 10 } } }).jpeg().toBuffer();
  }

  async function expectPng(images: readonly Buffer[]): Promise<void> {
    expect(images).toHaveLength(1);
    expect((await sharp(images[0]!).metadata()).format).toBe("png");
  }

  async function storedTaskId(): Promise<unknown> {
    const stored = await engine.metadata.artifacts.read<{ taskId: string }>(outputId, "kie-task-id");
    return stored.ok ? stored.value.taskId : null;
  }

  it("submits a WaveSpeed edit, retries a transient poll failure and keeps its saved task apart from Fal", async () => {
    const adapter = imageEditAdapter("wavespeed:google/nano-banana-2.1/edit")!;
    const edited = await jpeg();
    let polls = 0;
    route = (method, url) => {
      if (method === "POST" && url.href === "https://api.wavespeed.ai/api/v3/google/nano-banana-2.1/edit") {
        return Response.json({ code: 200, message: "success", data: { id: "ws-edit-1", model: "google/nano-banana-2.1/edit", status: "created", outputs: [] } });
      }
      if (method === "GET" && url.href === "https://api.wavespeed.ai/api/v3/predictions/ws-edit-1/result") {
        polls += 1;
        if (polls === 1) return Response.json({ code: 503, message: "busy" }, { status: 503 });
        const status = polls === 2 ? "processing" : "completed";
        return Response.json({ code: 200, message: "success", data: {
          id: "ws-edit-1", model: "google/nano-banana-2.1/edit", status,
          outputs: status === "completed" ? ["https://cdn.wavespeed.test/edited.jpeg"] : [],
        } });
      }
      if (url.href === "https://cdn.wavespeed.test/edited.jpeg") return new Response(new Uint8Array(edited));
      return null;
    };
    const request = adapter.buildRegionRequest(regionInput());
    const submitted = await adapter.submit(engine, outputId, request, new AbortController().signal);
    expect(submitted).toEqual({ kind: "pending", taskId: "ws-edit-1" });
    expect(calls[0]?.body).toEqual({
      prompt: "Replace the two marked regions with the reference identities",
      images: [SOURCE, ...REPLACEMENTS],
      aspect_ratio: "9:16",
      resolution: "2k",
      output_format: "png",
    });
    const payload = await engine.metadata.artifacts.read(outputId, "generation-payload");
    expect(payload.ok && payload.value).toEqual({ model: "wavespeed:google/nano-banana-2.1/edit", input: request.input });
    expect(await storedTaskId()).toBe("ws-edit-1");
    await expect(readStoredImageSubjectEditTask(engine, outputId)).resolves.toEqual({
      adapterId: "wavespeed:google/nano-banana-2.1/edit",
      request,
      taskId: "ws-edit-1",
    });
    await expectPng(await adapter.awaitResult("ws-edit-1", new AbortController().signal));
    expect(polls).toBe(3);
  });

  it("fails a WaveSpeed edit on a failed prediction or an unknown prediction without retrying", async () => {
    const adapter = imageEditAdapter("wavespeed:openai/gpt-image-2.6-flare/edit")!;
    route = (_method, url) => {
      if (url.pathname === "/api/v3/predictions/ws-failed/result") {
        return Response.json({ code: 200, message: "success", data: { id: "ws-failed", model: "x", status: "failed", error: "content flagged", outputs: [] } });
      }
      if (url.pathname === "/api/v3/predictions/ws-missing/result") {
        return Response.json({ code: 404, message: "prediction not found" }, { status: 404 });
      }
      return null;
    };
    await expect(adapter.awaitResult("ws-failed", new AbortController().signal))
      .rejects.toThrow("WaveSpeed image edit failed: content flagged");
    await expect(adapter.awaitResult("ws-missing", new AbortController().signal)).rejects.toThrow();
    expect(calls.filter((call) => call.url.endsWith("/ws-missing/result"))).toHaveLength(1);
  });

  it("submits a MachGen edit and downloads the finished image from its task asset", async () => {
    const adapter = imageEditAdapter("machgen:GPT-Image-2.6-Sunburst")!;
    const edited = await jpeg();
    let polls = 0;
    route = (method, url) => {
      if (method === "POST" && url.href === "https://api.machgen.ai/api/v0/generate") return Response.json({ task_id: "mg-edit-1" });
      if (method === "GET" && url.href === "https://api.machgen.ai/api/v0/tasks/mg-edit-1") {
        polls += 1;
        return Response.json(polls === 1
          ? { task_id: "mg-edit-1", status: "RUNNING", metadata: {} }
          : { task_id: "mg-edit-1", status: "COMPLETED", metadata: {}, task_output: { image: "https://api.machgen.ai/api/v0/assets/mg-edit-1" } });
      }
      if (method === "GET" && url.href === "https://api.machgen.ai/api/v0/assets/mg-edit-1") return new Response(new Uint8Array(edited));
      return null;
    };
    const request = adapter.buildSemanticRequest(semanticInput());
    const submitted = await adapter.submit(engine, outputId, request, new AbortController().signal);
    expect(submitted).toEqual({ kind: "pending", taskId: "mg-edit-1" });
    expect(calls[0]?.body).toMatchObject({
      model: "GPT-Image-2.6-Sunburst",
      task_type: "I2I",
      prompt: "Make the sky sunset orange",
      src_image_urls: [SOURCE],
    });
    expect(await storedTaskId()).toBe("mg-edit-1");
    await expectPng(await adapter.awaitResult("mg-edit-1", new AbortController().signal));
    expect(polls).toBe(2);
  });

  it("fails a MachGen edit with the provider's error message", async () => {
    const adapter = imageEditAdapter("machgen:Nano-Banana-2.1")!;
    route = (_method, url) => url.pathname === "/api/v0/tasks/mg-failed"
      ? Response.json({ task_id: "mg-failed", status: "FAILED", metadata: {}, error_msg: "moderation rejected" })
      : null;
    await expect(adapter.awaitResult("mg-failed", new AbortController().signal))
      .rejects.toThrow("MachGen image edit failed: moderation rejected");
  });

  it("runs Nunchux edits inline from book images and records no resumable task", async () => {
    const source = await engine.artifacts.create({ kind: "image", label: "Source" });
    if (!source.ok) throw new Error(source.error.message);
    const sourcePng = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const written = await engine.files.write(source.value.artifactId, "source.png", sourcePng);
    if (!written.ok) throw new Error(written.error.message);
    const edited = await jpeg();
    route = (method, url) => {
      if (method === "POST" && url.href === "https://api.nunchux.com/v1/google/v1beta/interactions") {
        return Response.json({
          id: "v1_nunchux-edit", object: "interaction", model: "gemini-nano-banana-2.1", status: "completed",
          steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: edited.toString("base64") }] }],
        });
      }
      if (method === "POST" && url.href === "https://api.nunchux.com/v2/openai/images/edits") {
        return Response.json({ created: 1795170000, output_format: "png", data: [{ b64_json: sourcePng.toString("base64"), generation_id: "gen_nunchux_edit" }] });
      }
      return null;
    };

    const nanoBanana = imageEditAdapter("nunchux:gemini-nano-banana-2.1")!;
    const ref = await nanoBanana.uploadAsset(engine, source.value.artifactId, "source.png");
    expect(ref).toBe(`asset://${source.value.artifactId}/source.png`);
    expect(calls).toEqual([]);
    const request = nanoBanana.buildSemanticRequest({ ...semanticInput(), imageUrls: [ref] });
    const submitted = await nanoBanana.submit(engine, outputId, request, new AbortController().signal);
    expect(submitted).toMatchObject({ kind: "done", taskId: "v1_nunchux-edit" });
    await expectPng(submitted.kind === "done" ? submitted.images : []);
    expect(calls[0]?.body).toMatchObject({
      model: "gemini-nano-banana-2.1",
      input: [
        { type: "text", text: "Make the sky sunset orange" },
        { type: "image", data: sourcePng.toString("base64"), mime_type: "image/png" },
      ],
      response_format: { type: "image", image_size: "2K", aspect_ratio: "16:9" },
    });
    const payload = await engine.metadata.artifacts.read(outputId, "generation-payload");
    expect(payload.ok && payload.value).toEqual({ model: "nunchux:gemini-nano-banana-2.1", input: request.input });
    expect(await storedTaskId()).toBeNull();
    await expect(readStoredImageSubjectEditTask(engine, outputId)).resolves.toBeNull();
    await expect(nanoBanana.awaitResult("v1_nunchux-edit", new AbortController().signal)).rejects.toThrow("no task to resume");

    const gptImage = imageEditAdapter("nunchux:gpt-image-2.6-sunburst")!;
    const gptSubmitted = await gptImage.submit(engine, outputId,
      gptImage.buildSemanticRequest({ ...semanticInput(), imageUrls: [ref] }), new AbortController().signal);
    expect(gptSubmitted).toMatchObject({ kind: "done", taskId: "gen_nunchux_edit" });
    expect(calls[1]?.body).toMatchObject({
      model: "gpt-image-2.6-sunburst",
      images: [{ image_url: `data:image/png;base64,${sourcePng.toString("base64")}` }],
      size: "2048x1152",
      output_format: "png",
    });
  });
});
