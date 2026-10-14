import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import sharp from "sharp";
import {
  ViduQ4ImageToVideoRequestSchema,
  ViduQ4ReferenceToVideoRequestSchema,
} from "@apicity/kie/zod";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests } from "../queue.js";
import { translateToolPayload } from "../payload-builders.js";
import { assessKieRequestEstimate, assessToolCallEstimate } from "../jobs/cost-estimate-assessment.js";
import { buildModelOption, extractLastUsedModel, getVideoToolSchema, VIDEO_MODELS } from "../video-models.js";
import type { listNotebookActions } from "../notebook-action-catalog.js";
import { runFfmpeg } from "../ffmpeg.js";

const imageTool = "generate_kie_vidu_q4_image_to_video";
const referenceTool = "generate_kie_vidu_q4_reference_to_video";
const imageUrl = "https://example.test/subject.png";
const audioUrl = "https://example.test/voice.mp3";

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]!.text!) as unknown;
}

describe("Vidu Q4 video generation", () => {
  let root: string;
  let engine: Engine;
  let client: Client;
  const originalKey = process.env.KIE_API_KEY;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-vidu-q4-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    process.env.KIE_API_KEY = "test-vidu-q4-key";
  });

  afterEach(async () => {
    await client.close();
    if (originalKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("queues both registered tools with their media and restores the selected model from history", async () => {
    for (const [tool, key] of [[imageTool, "vidu_q4_i2v"], [referenceTool, "vidu_q4_r2v"]] as const) {
      const args = {
        book_id: engine.book.get().bookId,
        image_refs: [imageUrl],
        duration: "16",
        resolution: "4k",
        audio: false,
        ...(tool === referenceTool ? { prompt: "Animate @image1 with @audio1", audio_refs: [audioUrl], aspect_ratio: "9:16" } : {}),
      };
      const response = resultJson(await client.callTool({ name: tool, arguments: args }));
      expect(response).toMatchObject({ status: "enqueued" });
      const jobs = engine.jobs.queue.list({ type: tool });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.payload).toMatchObject({ toolName: tool, args: { ...args, duration: 16 } });
      const history = [{ hash: "revision", action: `tool-${tool.replaceAll("_", "-")}`, payload: args, date: "2026-10-14T00:00:00Z" }];
      expect(extractLastUsedModel(history)).toBe(key);
      const option = buildModelOption(key, VIDEO_MODELS[key], {}, [], history);
      expect(option.tool_name).toBe(tool);
      expect(option.selected_provider).toBe("kie");
      expect(option.providers.map((provider) => provider.key)).toEqual(["kie"]);
      expect(option.prefilled_values).toMatchObject({ duration: "16", resolution: "4k", audio: false });
    }
  });

  it("rejects invalid requests before creating an output or queue entry", async () => {
    const base = { book_id: engine.book.get().bookId, image_refs: [imageUrl], prompt: "Animate the subject" };
    const invalid: Array<[string, Record<string, unknown>]> = [
      [imageTool, { image_refs: [] }],
      [imageTool, { image_refs: [imageUrl, imageUrl] }],
      [imageTool, { duration: 2 }],
      [imageTool, { duration: 17 }],
      [imageTool, { duration: 4.5 }],
      [imageTool, { resolution: "8k" }],
      [imageTool, { prompt: "x".repeat(20_001) }],
      [referenceTool, { prompt: "" }],
      [referenceTool, { image_refs: Array.from({ length: 16 }, () => imageUrl) }],
      [referenceTool, { audio_refs: Array.from({ length: 4 }, () => audioUrl) }],
      [referenceTool, { aspect_ratio: "auto" }],
    ];
    for (const [name, args] of invalid) {
      const result = await client.callTool({ name, arguments: { ...base, ...args } });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(engine.artifacts.list()).toEqual([]);
    expect(engine.jobs.queue.list()).toEqual([]);
  });

  it("builds published requests and rewrites ordered image and audio mentions", () => {
    const images = Array.from({ length: 15 }, (_, index) => `https://example.test/image-${index}.png`);
    const audios = Array.from({ length: 3 }, (_, index) => `https://example.test/audio-${index}.mp3`);
    const translated = translateToolPayload(referenceTool, {
      prompt: "Animate @image15 with @image1 using @audio3",
      image_refs: images,
      audio_refs: audios,
      duration: "16",
      resolution: "4k",
      aspect_ratio: "3:4",
      audio: false,
    });
    expect(translated?.provider_path).toBe("kie.post.api.v1.jobs.createTask(request, { otp })");
    expect(translated?.payload).toEqual({
      model: "vidu-q4/reference-to-video",
      input: {
        prompt: "Animate reference image 15 with reference image 1 using reference audio 3",
        reference_image_urls: images,
        reference_audio_urls: audios,
        duration: 16,
        resolution: "4k",
        aspect_ratio: "3:4",
        audio: false,
      },
    });
    expect(ViduQ4ReferenceToVideoRequestSchema.safeParse(translated?.payload).success).toBe(true);
    const image = translateToolPayload(imageTool, { image_refs: [imageUrl] });
    expect(ViduQ4ImageToVideoRequestSchema.parse(image?.payload)).toEqual({
      model: "vidu-q4/image-to-video",
      input: { image_url: imageUrl, duration: 5, resolution: "720p", audio: true },
    });
    const imageSchema = getVideoToolSchema(imageTool)!;
    expect(imageSchema.required).toEqual(["image_refs"]);
    expect(imageSchema.properties).not.toHaveProperty("aspect_ratio");
    expect(imageSchema.properties).not.toHaveProperty("audio_refs");
    expect(imageSchema.defaults).toMatchObject({ duration: "5", resolution: "720p", audio: true });
  });

  it("previews connected notebook images and audio with the selected settings", async () => {
    const bookId = engine.book.get().bookId;
    const { actions } = resultJson(await client.callTool({
      name: "list_notebook_actions", arguments: { book_id: bookId, cell_type: "generate_video" },
    })) as { actions: ReturnType<typeof listNotebookActions> };
    const action = actions.find((candidate) => candidate.tool === referenceTool);
    if (!action?.model) throw new Error("Missing Vidu reference action");
    expect(action.inputContract?.modes[0]?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "image_refs", min: 1, max: 15 }),
      expect.objectContaining({ field: "audio_refs", min: 0, max: 3 }),
    ]));
    expect(action.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "resolution", options: ["540p", "720p", "1080p", "2k", "4k"] }),
      expect.objectContaining({ name: "audio", defaultValue: true }),
    ]));
    const notebook = await engine.notebooks.create("Vidu Q4");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const image = await engine.artifacts.create("image", "Subject");
    const audio = await engine.artifacts.create("audio", "Voice");
    if (!image.ok || !audio.ok) throw new Error("Failed to create source artifacts");
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
    expect((await engine.files.write(image.value.artifactId, "original.png", png)).ok).toBe(true);
    const audioPath = join(audio.value.path, "original.mp3");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", audioPath]);
    expect((await engine.files.ingestWorkspace(audio.value.artifactId, ["original.mp3"])).ok).toBe(true);
    const sourceImage = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 0 }, outputArtifactId: image.value.artifactId });
    const sourceAudio = engine.notebooks.createCell({ type: "audio", slot: { row: 0, column: 1 }, outputArtifactId: audio.value.artifactId });
    const generation = engine.notebooks.createCell({
      type: "generate_video", slot: { row: 1, column: 0 }, prompt: "Animate @image1 with @audio1",
      provider: "kie", model: action.model, operation: action.operation, tool: referenceTool,
      inputs: { generationMode: "default", generationSettings: { duration: "3", resolution: "540p", aspect_ratio: "9:16", audio: false } },
    });
    expect((await engine.notebooks.write({
      ...notebook.value,
      cells: [sourceImage, sourceAudio, generation],
      edges: [
        engine.notebooks.createEdge({ source: sourceImage.id, target: generation.id, targetInput: "image" }),
        engine.notebooks.createEdge({ source: sourceAudio.id, target: generation.id, targetInput: "audio" }),
      ],
    })).ok).toBe(true);
    const preview = resultJson(await client.callTool({
      name: "preview_notebook_generation",
      arguments: { book_id: bookId, notebook_id: notebook.value.id, cell_id: generation.id },
    })) as { payload: unknown };
    const request = ViduQ4ReferenceToVideoRequestSchema.parse(preview.payload);
    expect(request.input).toMatchObject({
      prompt: "Animate reference image 1 with reference audio 1",
      duration: 3, resolution: "540p", aspect_ratio: "9:16", audio: false,
    });
    expect(request.input.reference_image_urls).toHaveLength(1);
    expect(request.input.reference_audio_urls).toHaveLength(1);
    expect(engine.jobs.queue.list()).toEqual([]);
  });

  it("matches tool and provider estimates at every resolution with and without audio", async () => {
    for (const tool of [imageTool, referenceTool]) {
      for (const [resolution, rate] of [["540p", 0.036], ["720p", 0.076], ["1080p", 0.096], ["2k", 0.152], ["4k", 0.312]] as const) {
        for (const audio of [false, true]) {
          const args = { prompt: "Animate", image_refs: [imageUrl], resolution, duration: "3", audio };
          const quote = await assessToolCallEstimate(engine, tool, args);
          expect(quote.available).toBe(true);
          expect(quote.usd).toBeCloseTo(rate * 3);
          const translated = translateToolPayload(tool, args)!;
          const request = tool === imageTool
            ? ViduQ4ImageToVideoRequestSchema.parse(translated.payload)
            : ViduQ4ReferenceToVideoRequestSchema.parse(translated.payload);
          expect(assessKieRequestEstimate(request).usd).toBeCloseTo(quote.usd!);
        }
      }
      const defaults = await assessToolCallEstimate(engine, tool, {});
      expect(defaults.available).toBe(true);
      expect(defaults.usd).toBeCloseTo(5 * 0.076);
    }
  });
});
