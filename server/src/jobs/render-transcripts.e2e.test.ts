import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, NotebookGridSlot } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readAnalysisComponent } from "../analysis-components.js";
import { cachedSidecarAnalysis, fileObjectHash } from "../analysis-sidecars.js";
import { createEngineForTest } from "../engine.js";
import { extractMp3, FFMPEG, probeVideo } from "../ffmpeg.js";
import { writeGraphicsDraft } from "../graphics/drafts.js";
import type { GraphicsLayerInput } from "../graphics/model.js";
import { graphicsDocumentFromLayers } from "../graphics/model.js";
import { saveGraphicsTemplate } from "../graphics/templates.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { reconcileProjectWork } from "../tools/reconcile-project-work.js";
import {
  DEFAULT_TRANSCRIPT_OPTIONS,
  ELEVENLABS_TRANSCRIPT,
  elevenLabsTranscriptKey,
  hasCurrentElevenLabsTranscript,
  OPENAI_TRANSCRIPT,
  openAiTranscriptKey,
  openAiTranscriptRecord,
  recordElevenLabsTranscript,
  recordOpenAiTranscript,
} from "../transcript-components.js";

const execFileAsync = promisify(execFile);
const DURATION = 2;
const PLAIN = ".analysis.gpt4otrans.json";
const TIMED = "elevenlabs.json";
const TRANSCRIPT = {
  language_code: "eng",
  words: [
    { text: "Hello", start: 0.2, end: 0.7, type: "word" },
    { text: "big", start: 0.8, end: 1.1, type: "word" },
    { text: "world.", start: 1.2, end: 1.8, type: "word" },
  ],
};
const TITLE: GraphicsLayerInput = { kind: "text", name: "Title", items: [{ text: "SALE", size: 0.08 }], plate: { color: "#FF00FF", opacity: 1, radius: 0 } };
const recordValue = z.object({ sidecarHash: z.string() });

type TextContent = Array<{ type: string; text: string }>;
type Render = { status: string; output_asset_id: string; error: string | null };
type GraphicsRead = { revision: string; source: { source_hash: string }; render: Render | null };
type CaptionRead = { status: string; source: { media_hash: string }; draft: { revision: string } | null; render: Render | null };
type Batch = { results: Array<{ asset_id: string; status: string; render?: { output_asset_id: string } }> };

describe("render outputs keep their source's speech-to-text", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let notebookId: string;
  let clips = 0;
  const bookId = "render-transcripts-book";

  async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  }

  const graphics = <T>(args: Record<string, unknown>) => tool<T>("video_graphics", args);
  const captions = <T>(assetId: string, args: Record<string, unknown>) => tool<T>("caption_video", { asset_id: assetId, ...args });

  async function videoPath(artifactId: string): Promise<string> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return join(manifest.value.path, "original.mp4");
  }

  async function originalOf(artifactId: string): Promise<Record<string, unknown>> {
    const read = await engine.metadata.artifacts.read<Record<string, unknown>>(artifactId, "original");
    if (!read.ok) throw new Error(read.error.message);
    return read.value;
  }

  async function audioOf(artifactId: string): Promise<string> {
    const hash = await fileObjectHash(engine, artifactId, "original.mp3");
    if (!hash) throw new Error(`original.mp3 missing from ${artifactId}`);
    return hash;
  }

  async function transcribedVideo(label: string, slot: NotebookGridSlot, width = 720, height = 1280): Promise<string> {
    clips += 1;
    const path = join(tempDir, `source-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x2060a0:s=${width}x${height}:r=30:d=${DURATION}`,
      "-f", "lavfi", "-i", `sine=frequency=${300 + clips * 40}:sample_rate=44100:duration=${DURATION}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ]);
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const video = await engine.files.writeFromPath(artifactId, "original.mp4", path);
    if (!video.ok) throw new Error(video.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(path));
    const mp3 = join(tempDir, `source-${clips}.mp3`);
    await extractMp3(path, mp3);
    const audio = await engine.files.writeFromPath(artifactId, "original.mp3", mp3);
    if (!audio.ok) throw new Error(audio.error.message);
    for (const [name, content] of [[PLAIN, { text: "Hello big world." }], [TIMED, TRANSCRIPT]] as const) {
      const written = await engine.files.write(artifactId, name, JSON.stringify(content));
      if (!written.ok) throw new Error(written.error.message);
    }
    const audioHash = await audioOf(artifactId);
    await recordOpenAiTranscript(engine, artifactId, audioHash);
    await recordElevenLabsTranscript(engine, { artifactId, audioHash, options: DEFAULT_TRANSCRIPT_OPTIONS });
    const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", slot, outputArtifactId: artifactId }));
    if (!inserted.ok) throw new Error(inserted.error.message);
    return artifactId;
  }

  async function graphicsRendered(assetId: string): Promise<string> {
    await expect.poll(async () => {
      const render = (await graphics<GraphicsRead>({ asset_id: assetId, notebook_id: notebookId })).render;
      if (render?.status === "failed") throw new Error(render.error ?? "Render failed");
      return render?.status;
    }, { timeout: testBudget(300_000), interval: 1000 }).toBe("completed");
    return (await graphics<GraphicsRead>({ asset_id: assetId, notebook_id: notebookId })).render!.output_asset_id;
  }

  async function renderGraphics(assetId: string, frame?: Record<string, unknown>): Promise<string> {
    const before = await graphics<GraphicsRead>({ asset_id: assetId, notebook_id: notebookId });
    const saved = await graphics<{ revision: string }>({
      asset_id: assetId, notebook_id: notebookId, op: "update", expected_revision: before.revision,
      document: graphicsDocumentFromLayers([TITLE]), ...(frame ? { frame } : {}),
    });
    await graphics({ asset_id: assetId, notebook_id: notebookId, op: "render", expected_revision: saved.revision, source_hash: before.source.source_hash, request_id: randomUUID() });
    return graphicsRendered(assetId);
  }

  async function renderStacked(assetId: string): Promise<string> {
    await captions(assetId, { op: "prepare" });
    await expect.poll(async () => (await captions<CaptionRead>(assetId, {})).status, { timeout: testBudget(120_000), interval: 250 }).toBe("ready");
    const current = await captions<CaptionRead>(assetId, { detail: "full" });
    const drawn = writeGraphicsDraft(engine, assetId, graphicsDocumentFromLayers([TITLE]));
    await captions(assetId, {
      op: "render", notebook_id: notebookId, expected_revision: current.draft!.revision, source_hash: current.source.media_hash,
      request_id: randomUUID(), with_graphics: true, graphics_revision: drawn.revision,
    });
    await expect.poll(async () => {
      const render = (await captions<CaptionRead>(assetId, {})).render;
      if (render?.status === "failed") throw new Error(render.error ?? "Render failed");
      return render?.status;
    }, { timeout: testBudget(300_000), interval: 1000 }).toBe("completed");
    return (await captions<CaptionRead>(assetId, {})).render!.output_asset_id;
  }

  async function expectCurrentTranscripts(artifactId: string): Promise<void> {
    const audioHash = await audioOf(artifactId);
    expect(await cachedSidecarAnalysis(engine, OPENAI_TRANSCRIPT, openAiTranscriptRecord(artifactId, audioHash))).toBe(true);
    expect(await hasCurrentElevenLabsTranscript(engine, { artifactId, audioHash, options: DEFAULT_TRANSCRIPT_OPTIONS })).toBe(true);
  }

  async function expectSourceTranscripts(outputId: string, sourceId: string): Promise<void> {
    const audioHash = await audioOf(outputId);
    expect(audioHash).not.toBe(await audioOf(sourceId));
    for (const name of [PLAIN, TIMED]) expect(await fileObjectHash(engine, outputId, name)).toBe(await fileObjectHash(engine, sourceId, name));
    expect(readAnalysisComponent(engine, OPENAI_TRANSCRIPT, openAiTranscriptKey(audioHash), recordValue)?.provenance).toMatchObject({ provider: null, model: null, copiedFrom: sourceId });
    expect(readAnalysisComponent(engine, ELEVENLABS_TRANSCRIPT, elevenLabsTranscriptKey(audioHash, DEFAULT_TRANSCRIPT_OPTIONS), recordValue)?.provenance).toMatchObject({ provider: null, model: null, copiedFrom: sourceId });
    await expectCurrentTranscripts(outputId);
    expect(await originalOf(outputId)).toMatchObject({ hasAudio: true });
    expect(await originalOf(outputId)).not.toHaveProperty("transcribe");
  }

  async function expectNoSpeechToText(artifactIds: readonly string[]): Promise<void> {
    const requests: string[] = [];
    const passThrough = globalThis.fetch;
    vi.stubEnv("OPENAI_API_KEY", "offline-openai-key");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("api.openai.com")) return passThrough(input, init);
      requests.push(url);
      return Response.json({ text: "Hello big world." });
    });
    try {
      const result = await reconcileProjectWork(engine, engine.book.get().bookId);
      expect(result.auto_plain_transcript).toEqual([]);
      await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
      for (const artifactId of artifactIds) {
        expect(engine.jobs.queue.list({ type: "transcribe_video_audio", artifactId })).toEqual([]);
        expect(engine.jobs.queue.list({ type: "transcribe", artifactId })).toEqual([]);
      }
      expect(requests).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("ELEVENLABS_API_KEY", "");
    }
  }

  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    tempDir = await mkdtemp(join(tmpdir(), "videobook-render-transcripts-e2e-"));
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("gives graphics, reframed, stacked and batch renders their source's transcripts and queues no speech-to-text", async () => {
    const street = await transcribedVideo("street", { row: 0, column: 0 });
    const plain = await renderGraphics(street);
    const landscape = await transcribedVideo("landscape", { row: 0, column: 4 }, 640, 360);
    const reframed = await renderGraphics(landscape, { aspect: "9:16", fit: "crop", focus: { x: 0.5, y: 0.5 } });
    const stacked = await renderStacked(street);
    const batchSources = [
      await transcribedVideo("first", { row: 8, column: 0 }),
      await transcribedVideo("second", { row: 8, column: 3 }),
      await transcribedVideo("third", { row: 8, column: 6 }),
    ];
    const template = await saveGraphicsTemplate(engine, { name: "Sale", document: graphicsDocumentFromLayers([TITLE]) });
    const batch = await graphics<Batch>({ op: "apply_template", asset_ids: batchSources, template_id: template.id, request_id: randomUUID() });
    expect(batch.results.map((entry) => entry.status)).toEqual(["rendering", "rendering", "rendering"]);
    const batchOutputs: string[] = [];
    for (const source of batchSources) batchOutputs.push(await graphicsRendered(source));
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(120_000) });

    const reframedProbe = await probeVideo(await videoPath(reframed));
    expect(reframedProbe.height).toBeGreaterThan(reframedProbe.width);
    const pairs: Array<[string, string]> = [[plain, street], [reframed, landscape], [stacked, street], ...batchOutputs.map((output, index): [string, string] => [output, batchSources[index]])];
    for (const [output, source] of pairs) await expectSourceTranscripts(output, source);
    await expectNoSpeechToText(pairs.flat());
  }, testBudget(900_000));

  it("keeps a video's transcripts current through an in-place watermark burn and crop", async () => {
    const burned = await transcribedVideo("watermarked", { row: 16, column: 0 });
    const cropped = await transcribedVideo("cropped", { row: 16, column: 4 });
    const audioBefore = [await audioOf(burned), await audioOf(cropped)];
    const videoBefore = [await fileObjectHash(engine, burned, "original.mp4"), await fileObjectHash(engine, cropped, "original.mp4")];

    await tool("apply_watermark", { asset_id: burned, platform: "x", handle: "alice", include_qr: false });
    const crop = await tool<{ status: string }>("crop_asset", { asset_id: cropped, ratio: "1:1", x: 0, y: (1 - 720 / 1280) / 2, w: 1, h: 720 / 1280 });
    expect(crop.status).toBe("completed");
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(120_000) });

    expect([await fileObjectHash(engine, burned, "original.mp4"), await fileObjectHash(engine, cropped, "original.mp4")]).not.toEqual(videoBefore);
    expect([await audioOf(burned), await audioOf(cropped)]).toEqual(audioBefore);
    for (const artifactId of [burned, cropped]) {
      for (const name of [PLAIN, TIMED]) expect(await fileObjectHash(engine, artifactId, name)).not.toBeNull();
      await expectCurrentTranscripts(artifactId);
    }
    await expectNoSpeechToText([burned, cropped]);
  }, testBudget(600_000));
});
