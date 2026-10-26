import { createEngineForTest } from "../engine.js";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import { withBookContext } from "../book-context.js";
import { runFfmpeg } from "../ffmpeg.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { chatActionPlanSchema, prepareVoiceChatAction } from "./chat.js";
import {
  buildCutsContext,
  extractSilenceCandidates,
  filterValidTrims,
  loadAssetForAnalysis,
  type Trim,
} from "./_suggest-shared.js";

type TextContent = Array<{ type: string; text: string }>;

describe("suggest_cuts tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "videobook-cut-fixtures-"));
    for (const hasAudio of [false, true]) {
      await copyVideoFixture({
        width: 160, height: 90, durationSec: 6, fps: 10, source: "testsrc",
        audio: hasAudio ? { frequency: 440 } : false,
      }, join(fixtureDir, `${hasAudio}.mp4`));
    }
    await runFfmpeg([
      "-y", "-ss", "0.5", "-i", join(fixtureDir, "false.mp4"),
      "-frames:v", "1", join(fixtureDir, "frame.jpg"),
    ]);
  });

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    delete process.env.OPENAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-suggest-cuts-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "cuts-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    if (originalKey) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createProcessedVideo(hasAudio = false) {
    const engine = createEngineForTest(tempDir);
    const asset = await engine.artifacts.create("video", "pacing source");
    if (!asset.ok) throw new Error(asset.error.message);
    const assetId = asset.value.artifactId;
    const writes = [
      await engine.files.writeFromPath(assetId, "original.mp4", join(fixtureDir, `${hasAudio}.mp4`)),
      await engine.files.writeFromPath(assetId, "original_frames/0.500.jpg", join(fixtureDir, "frame.jpg")),
      await engine.metadata.artifacts.write(assetId, "original", {
        width: 160, height: 90, duration: 6, hasAudio,
      }),
    ];
    for (const write of writes) if (!write.ok) throw new Error(write.error.message);
    return { engine, assetId };
  }

  it("returns error when OPENAI_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: "vid-anything", book_id: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("returns error for nonexistent asset", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: "vid-does-not-exist", book_id: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no video file", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "empty-vid");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.artifactId, "notes.txt", "hello");

    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: asset.value.artifactId, book_id: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("returns error when asset has no frames", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "no-frames-vid");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from([0]));

    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: asset.value.artifactId, book_id: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no frames");
    expect(content[0].text).toContain("/process-video");
    expect(content[0].text).not.toContain(asset.value.artifactId);
  });

  it.each([false, true])("enqueues visual cuts without a transcript (hasAudio=%s)", async (hasAudio) => {
    process.env.OPENAI_API_KEY = "test-key";
    const { engine, assetId } = await createProcessedVideo(hasAudio);
    const original = await engine.files.read(assetId, "original.mp4");
    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: assetId, book_id: "cuts-proj", instructions: "smoother transitions and better timing" },
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content as TextContent)[0].text)).toMatchObject({ asset_id: assetId, status: "queued" });
    expect(engine.jobs.queue.list({ type: "suggest_cuts" })).toMatchObject([{
      payload: { assetId, instructions: "smoother transitions and better timing" },
    }]);
    expect(await engine.files.read(assetId, "original.mp4")).toEqual(original);
    expect((await engine.files.read(assetId, ".suggest-cuts.json")).ok).toBe(false);
  });

  it("applies the reviewed @d1 chat action without requiring a transcript", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const { engine, assetId } = await createProcessedVideo();
    const bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    await engine.notebooks.insertCell(notebook.value.id, engine.notebooks.createCell({
      type: "video", slot: { row: 3, column: 0 }, outputArtifactId: assetId,
    }));
    const routed = await withBookContext({ bookId, engine }, () => prepareVoiceChatAction(engine, {
      book_id: bookId, notebook_id: notebook.value.id,
      prompt: "trim @d1 for smoother transitions better timing",
    }, {
      tool: "suggest_cuts", params: { asset_id: assetId, instructions: "smoother transitions better timing" },
      message: "Reviewing video pacing.",
    }));
    expect(routed.isError).toBeUndefined();
    const plan = chatActionPlanSchema.parse(JSON.parse(routed.content[0].text));
    expect(plan.confirmation.required).toBe(true);
    expect(engine.jobs.queue.list({ type: "suggest_cuts" })).toHaveLength(0);
    const result = await client.callTool({ name: "chat", arguments: { book_id: bookId, action_plan: plan } });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content as TextContent)[0].text)).toMatchObject({ asset_id: assetId, status: "queued" });
  });

  it.each(["missing", "empty"])("builds visual context for a %s transcript without claiming silence", async (transcriptState) => {
    const { engine, assetId } = await createProcessedVideo(true);
    if (transcriptState === "empty") {
      await engine.files.write(assetId, "elevenlabs.json", JSON.stringify({ text: "", words: [] }));
      await engine.files.write(assetId, ".analysis.gpt4otrans.json", JSON.stringify({ text: "" }));
    }
    const loaded = await loadAssetForAnalysis(engine, assetId, { requireTranscript: false });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const { meta, prior, transcript, frameNames } = loaded.value;
    expect(transcript.source).toBe("none");
    const context = buildCutsContext(meta, prior, transcript, frameNames.length, [], 2.4, "smoother transitions better timing");
    expect(context).toContain("Editing request: smoother transitions better timing");
    expect(context).toContain("Transcript: unavailable");
    expect(context).toContain("do not infer speech, silence, filler words, or audio events");
    expect(context).not.toContain("transcript has no gaps");
    const required = await loadAssetForAnalysis(engine, assetId);
    expect(required).toMatchObject({ ok: false, error: { kind: "no-transcript" } });
    if (!required.ok) expect(required.error.message).not.toContain(assetId);
    const trims: Trim[] = [
      { cut_start: 0, cut_end: 0.3, reason: "Redundant opening hold", severity: "low" },
      { cut_start: 1, cut_end: 1.2, reason: "Invented filler", severity: "med" },
      { cut_start: 2, cut_end: 3, reason: "Invented silence", severity: "high" },
      { cut_start: 5.8, cut_end: 6.1, reason: "Past the end", severity: "low" },
    ];
    const validated = filterValidTrims(trims, [], 2.4, { duration: 6, transcriptSource: transcript.source });
    expect(validated.kept).toEqual([trims[0]]);
    expect(validated.dropped).toHaveLength(3);
  });

  it("preserves word-timed dialogue suggestions and the overlap and budget guards", async () => {
    const { engine, assetId } = await createProcessedVideo(true);
    await engine.files.write(assetId, "elevenlabs.json", JSON.stringify({
      text: "Hello um world", words: [
        { type: "word", text: "Hello", start: 0, end: 0.5 },
        { type: "word", text: "um", start: 2.5, end: 2.7 },
        { type: "word", text: "world", start: 2.8, end: 3 },
      ],
    }));
    const loaded = await loadAssetForAnalysis(engine, assetId, { requireTranscript: false });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const { transcript, meta, prior, frameNames } = loaded.value;
    if (transcript.source !== "elevenlabs") throw new Error("Expected timed transcript");
    const candidates = extractSilenceCandidates(transcript.words, 1.5);
    expect(candidates).toEqual([{ start: 0.5, end: 2.5, duration: 2 }]);
    const context = buildCutsContext(meta, prior, transcript, frameNames.length, candidates, 2.4);
    expect(context).toContain("Hello");
    expect(context).toContain("word-level");
    expect(context).not.toContain("Transcript: unavailable");
    const trims: Trim[] = [
      { cut_start: 0.7, cut_end: 2.3, reason: "Pause", severity: "high" },
      { cut_start: 1, cut_end: 1.3, reason: "Overlapping pause", severity: "low" },
      { cut_start: 2.5, cut_end: 2.7, reason: "um", severity: "med" },
      { cut_start: 3, cut_end: 5, reason: "Over budget", severity: "low" },
    ];
    const validated = filterValidTrims(trims, candidates, 2.4, { duration: 6, transcriptSource: transcript.source });
    expect(validated.kept).toEqual([trims[0], trims[2]]);
    expect(validated.dropped.map(({ reason }) => reason)).toEqual([
      expect.stringContaining("overlaps"), expect.stringContaining("budget exceeded"),
    ]);
  });

  it("uses plain transcripts for context without inventing word timings", async () => {
    const { engine, assetId } = await createProcessedVideo(true);
    await engine.files.write(assetId, ".analysis.gpt4otrans.json", JSON.stringify({ text: "Hello world" }));
    const loaded = await loadAssetForAnalysis(engine, assetId, { requireTranscript: false });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const { transcript, meta, prior, frameNames } = loaded.value;
    expect(transcript.source).toBe("gpt4otrans");
    expect(buildCutsContext(meta, prior, transcript, frameNames.length, [], 2.4)).toContain("Hello world");
    expect(filterValidTrims([
      { cut_start: 0, cut_end: 0.3, reason: "Untimed filler", severity: "med" },
    ], [], 2.4, { duration: 6, transcriptSource: transcript.source }).kept).toEqual([]);
  });
});
