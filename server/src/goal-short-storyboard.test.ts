import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { preflightAndAccept, waitForChainRun } from "./chain-executor.js";
import { createEngineForTest } from "./engine.js";
import { runFfmpeg } from "./ffmpeg.js";
import { buildGoalShortPlan, compileShortStoryboardStep } from "./goal-short-plan.js";
import { estimateShort } from "./goal-short-runtime.js";
import {
  captureStoryboardFrames, shortStoryboard, storyboardMoments, videoStoryboardMoments,
  type StoryboardVideo,
} from "./goal-short-storyboard.js";
import { installFalDynamicEstimator } from "./media/cost.js";
import { configureProviderEndpoints } from "./media/endpoints.js";
import { configureProviderPollDriverForTests, resetProviderPollDriverForTests } from "./queue.js";
import { writeTaggingSettings } from "./tag-settings.js";
import { testBudget } from "./test-budget.js";
import { createTestClient } from "./test-client.js";
import { redirectFalStorage, startShortStub, type ShortStub } from "./test-short-stub.js";
import { getAllToolDefs } from "./tools/index.js";

const CLEANUP_MODEL = "fal:google/nano-banana-2.1/edit";
const GRAPHICS = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
  <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.75"/></linearGradient></defs>
  <rect x="0" y="1280" width="1080" height="640" fill="url(#shade)"/>
  <text x="60" y="230" font-family="sans-serif" font-weight="900" font-size="160" fill="#fff" stroke="#000" stroke-width="8">WUT!</text>
  <rect x="60" y="262" width="390" height="18" fill="#ffd400"/>
  <rect x="40" y="860" width="72" height="72" rx="16" fill="#fff"/>
  <text x="128" y="910" font-family="sans-serif" font-size="44" fill="#fff">TikTok/@someone</text>
</svg>`;

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("storyboardMoments", () => {
  it("takes the middle of each quarter of a video without cuts", () => {
    expect(storyboardMoments({ durationSeconds: 13.27, cutSeconds: [] })).toEqual([1.66, 4.98, 8.29, 11.61]);
  });

  it("takes one moment per shot, at its middle, when the video has cuts", () => {
    expect(storyboardMoments({ durationSeconds: 10, cutSeconds: [3, 7] })).toEqual([1.5, 5, 8.5]);
    expect(storyboardMoments({ durationSeconds: 10, cutSeconds: [7, 3, 3, 12, -1] })).toEqual([1.5, 5, 8.5]);
  });

  it("merges the shortest shots when the video has more shots than frames", () => {
    expect(storyboardMoments({ durationSeconds: 12, cutSeconds: [1, 2, 6, 7, 9] })).toEqual([0.5, 4, 8, 10.5]);
    expect(storyboardMoments({ durationSeconds: 12, cutSeconds: [1, 2, 6, 7, 9], count: 2 })).toEqual([4, 10.5]);
    expect(storyboardMoments({ durationSeconds: 12, cutSeconds: [1, 2, 6, 7, 9], count: 1 })).toEqual([4]);
    expect(storyboardMoments({ durationSeconds: 12, cutSeconds: [], count: 0 })).toEqual([]);
  });

  it("keeps a quarter second from every cut and both ends, and takes fewer moments from a very short video", () => {
    expect(storyboardMoments({ durationSeconds: 10, cutSeconds: [0.3, 5] })).toEqual([2.65, 7.5]);
    expect(storyboardMoments({ durationSeconds: 2.4, cutSeconds: [] })).toEqual([0.6, 1.8]);
    expect(storyboardMoments({ durationSeconds: 0.8, cutSeconds: [] })).toEqual([0.4]);
    expect(storyboardMoments({ durationSeconds: 0.4, cutSeconds: [] })).toEqual([]);
  });

  it("starts the storyboard at fromSeconds", () => {
    expect(storyboardMoments({ durationSeconds: 13.27, cutSeconds: [], fromSeconds: 3 })).toEqual([4.28, 6.85, 9.42, 11.99]);
    expect(storyboardMoments({ durationSeconds: 10, cutSeconds: [2, 6], fromSeconds: 3 })).toEqual([4.5, 8]);
    expect(storyboardMoments({ durationSeconds: 10, cutSeconds: [6], fromSeconds: 5.8 })).toEqual([8]);
    expect(storyboardMoments({ durationSeconds: 10, cutSeconds: [], fromSeconds: 9.8 })).toEqual([]);
  });
});

describe("goal short storyboard of a video", () => {
  let stub: ShortStub;
  let fixtures: string;
  let videoPath: string;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let video: Required<StoryboardVideo>;
  let restoreFetch: () => void;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-storyboard-fixtures-"));
    const graphics = join(fixtures, "graphics.png");
    await writeFile(graphics, await sharp(Buffer.from(GRAPHICS)).png().toBuffer());
    videoPath = join(fixtures, "umbrella.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=0x4f6b3a:s=1080x1920:r=30:d=2.4[s0];color=c=0x7d8fa6:s=1080x1920:r=30:d=3.6[s1];[s0][s1]concat=n=2:v=1:a=0[out0]",
      "-i", graphics,
      "-filter_complex", "[0:v][1:v]overlay=0:0,format=yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast", "-an",
      videoPath,
    ]);
    const clip = await readFile(videoPath);
    stub = await startShortStub({ frame: await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#4f6b3a" } }).png().toBuffer(), clip, extended: clip });
  });

  afterAll(async () => {
    await stub.close();
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    stub.reset();
    for (const [key, setting] of [["FAL_API_KEY", "local-fal-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]] as const) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = setting;
    }
    restoreFetch = redirectFalStorage(stub.baseURL);
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    configureProviderPollDriverForTests({ intervalMs: 50 });
    root = await mkdtemp(join(tmpdir(), "videobook-storyboard-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    notebookId = value(await engine.notebooks.create("Umbrella")).id;
    const artifactId = value(await engine.artifacts.create("video", "Umbrella walk")).artifactId;
    value(await engine.files.writeFromPath(artifactId, "original.mp4", videoPath));
    const cell = engine.notebooks.createCell({ type: "video", label: "Umbrella walk", slot: { row: 0, column: 0 }, outputArtifactId: artifactId });
    value(await engine.notebooks.write({ ...value(engine.notebooks.read(notebookId)), cells: [cell] }));
    video = { artifactId, cellId: cell.id };
  });

  afterEach(async () => {
    await client.close();
    resetProviderPollDriverForTests();
    restoreEstimator();
    restoreEndpoints();
    restoreFetch();
    for (const [key, setting] of savedEnv) {
      if (setting === undefined) delete process.env[key];
      else process.env[key] = setting;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const notebook = (): NotebookDocument => value(engine.notebooks.read(notebookId));
  const frameCells = () => notebook().cells.filter((cell) => cell.inputs?.mediaRole === "extract-frame-output");
  const imageCount = () => engine.artifacts.list().filter((artifact) => artifact.kind === "image").length;

  async function imageSize(artifactId: string): Promise<{ width?: number; height?: number }> {
    const manifest = value(await engine.files.manifest(artifactId));
    const file = findPrimaryMediaFile(manifest.files, "image");
    if (!file) throw new Error(`${artifactId} has no image`);
    const { width, height } = await sharp(value(await engine.files.read(artifactId, file.name))).metadata();
    return { width, height };
  }

  it("captures one frame per shot into reading-order image cells and reuses them on a second call", async () => {
    const moments = await videoStoryboardMoments(engine, bookId, video.artifactId);
    expect(moments).toEqual([1.2, 4.2]);
    expect(await videoStoryboardMoments(engine, bookId, video.artifactId, { fromSeconds: 3 })).toEqual([3.5, 4.5, 5.5]);
    expect(engine.jobs.queue.list({ type: "detect_scenes" })).toHaveLength(1);
    const frames = await captureStoryboardFrames(engine, notebookId, video, moments);
    expect(frames).toEqual([
      expect.objectContaining({ index: 0, atSeconds: 1.2, requestedSeconds: 1.2, aspectRatio: "9:16", address: "@a2", label: "Storyboard 1 of 2 · 1.2 s" }),
      expect.objectContaining({ index: 1, atSeconds: 4.2, requestedSeconds: 4.2, aspectRatio: "9:16", address: "@a3", label: "Storyboard 2 of 2 · 4.2 s" }),
    ]);
    expect(await imageSize(frames[0]!.artifactId)).toEqual({ width: 1080, height: 1920 });
    for (const frame of frames) {
      expect(notebook().cells.find((cell) => cell.id === frame.cellId)).toMatchObject({
        type: "image",
        label: frame.label,
        outputArtifactId: frame.artifactId,
        inputs: {
          mediaRole: "extract-frame-output",
          sourceArtifactId: video.artifactId,
          sourceCellId: video.cellId,
          frameMode: "time",
          atSeconds: frame.atSeconds,
          requestedSeconds: frame.requestedSeconds,
          storyboardIndex: frame.index,
        },
      });
    }
    const images = imageCount();
    const again = await captureStoryboardFrames(engine, notebookId, video, moments);
    expect(again).toEqual(frames);
    expect(frameCells()).toHaveLength(2);
    expect(imageCount()).toBe(images);
  });

  it("builds and prices one on-screen-graphics clean-up per frame, and runs them through fal into connected clean-frame cells", async () => {
    const frames = await captureStoryboardFrames(engine, notebookId, video, await videoStoryboardMoments(engine, bookId, video.artifactId));
    const storyboard = shortStoryboard({ artifactId: video.artifactId, cellId: video.cellId, address: "@a1", label: "Umbrella walk" }, frames);
    expect(storyboard).toMatchObject({ model: CLEANUP_MODEL, frames: frames.map(({ requestedSeconds: _requested, ...frame }) => ({ ...frame, prompt: expect.any(String) })) });
    const steps = frames.map((frame) => compileShortStoryboardStep(storyboard, frame.index));
    expect(steps[0]).toEqual({
      id: "storyboard1",
      tool: "generate_image",
      params: {
        model: CLEANUP_MODEL,
        prompt: expect.any(String),
        refs: { image: ["@a2"] },
        options: { aspect_ratio: "9:16", output_format: "jpeg" },
      },
    });
    expect(steps.map((step) => step.id)).toEqual(["storyboard1", "storyboard2"]);
    const prompt = String(steps[0]!.params.prompt);
    for (const phrase of [
      "Remove every on-screen graphic that was added on top of the camera picture",
      "captions, titles and any other overlaid text, stickers and their underlines, emoji, platform logos and watermarks, creator credits and usernames with their icons, progress bars, borders, black or blurred bars, and darkening shade gradients",
      "Fill each of those areas with what the camera saw there",
      "keep the people, animals and objects exactly as they are",
      "a logo printed on an umbrella stays",
      "keep the place, light, colour, framing and size",
    ]) expect(prompt).toContain(phrase);
    expect(steps[1]!.params).toEqual({ ...steps[0]!.params, refs: { image: ["@a3"] } });

    const plan = buildGoalShortPlan({
      title: "Umbrella", aspectRatio: "9:16", sourceImages: [], storyboard, framePrompt: "A walk in the rain.", beats: ["They walk on."], segmentSeconds: [12],
    });
    const estimate = await estimateShort(engine, plan, { brief: "walk with the umbrella like @d1", draft: null });
    expect(estimate.storyboards.usd).toBeCloseTo(0.42);
    expect(estimate.storyboardFrames?.map((frame) => frame.usd)).toEqual([0.21, 0.21]);
    const restoreUnpriced = installFalDynamicEstimator(null);
    try {
      const unpriced = await estimateShort(engine, plan, { brief: "walk with the umbrella like @d1", draft: null });
      expect(unpriced.storyboards.usd).toBeNull();
      expect(unpriced.storyboards.warnings.length).toBeGreaterThan(0);
      expect(unpriced.total.usd).toBeNull();
    } finally {
      restoreUnpriced();
    }
    expect(stub.submissions).toEqual([]);

    const defs = getAllToolDefs(engine);
    const accepted = await preflightAndAccept({
      action: "run", version: 1, book_id: bookId, notebook_id: notebookId, request_id: "storyboard-cleanup", steps,
    }, {
      engine, bookId, notebookId,
      toolSchemas: new Map(defs.map((def) => [def.name, def.schema])),
      autoApplyTools: new Set(),
      effectForTool: () => "generation",
    }, (name) => defs.find((def) => def.name === name), { actor: "chat" });
    const run = await waitForChainRun(engine, accepted.chainId, testBudget(90_000));
    expect(run.status, run.error ?? "").toBe("completed");
    expect(stub.submissions.map((submission) => submission.path)).toEqual(["/google/nano-banana-2.1/edit", "/google/nano-banana-2.1/edit"]);
    for (const submission of stub.submissions) {
      expect(submission.body).toMatchObject({ prompt, aspect_ratio: "9:16", output_format: "jpeg", image_urls: [expect.stringMatching(/^http/u)] });
    }
    const jobs = engine.jobs.queue.list({ type: "generate_media", limit: 10 }).filter((job) => job.payload.model === CLEANUP_MODEL);
    expect(jobs.map((job) => job.payload.refs)).toEqual(expect.arrayContaining(frames.map((frame) => ({ image: [frame.artifactId] }))));
    const document = notebook();
    for (const [index, step] of run.steps.entries()) {
      const producer = document.cells.find((cell) => cell.inputs?.chainRunId === `${run.chainId}:${step.id}`);
      const output = document.cells.find((cell) => cell.id === step.outputs?.cell_id);
      expect(producer).toMatchObject({ type: "generate_image" });
      expect(output).toMatchObject({ type: "image", outputArtifactId: step.outputs?.asset_id });
      expect(document.edges).toContainEqual(expect.objectContaining({ source: producer!.id, target: output!.id }));
      expect(document.edges).toContainEqual(expect.objectContaining({ source: frames[index]!.cellId, target: producer!.id }));
      expect(await imageSize(String(step.outputs?.asset_id))).toEqual({ width: 1080, height: 1920 });
    }
    expect(stub.unexpected).toEqual([]);
  });
});
