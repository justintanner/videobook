import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  type Engine,
  type NotebookDocument,
} from "videobook-engine";
import { FFMPEG } from "../../server/src/ffmpeg.js";
import {
  modelArgs,
  prepareNotebookGeneration,
  resolveNotebookGenerationTool,
  runNotebookCell,
} from "../../server/src/jobs/run-notebook.js";
import { DEFAULT_ANIMATION_TOOL } from "../../server/src/notebook-action-catalog.js";
import { buildAssetList } from "../../server/src/tools/sync.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";

const execFileAsync = promisify(execFile);

async function makeClip(path: string, seconds = 2): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=24:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    path,
  ]);
}

describe("notebook runner frames and concat", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("resolves generation tool from a generate_video cell before provider model id", () => {
    const tool = resolveNotebookGenerationTool({
      id: "019f0000-0000-7000-8000-000000000001",
      type: "generate_video",
      slug: "generate-video-animate",
      slot: { row: 0, column: 0 },
      model: "bytedance/seedance-2",
      tool: DEFAULT_ANIMATION_TOOL,
    });
    expect(tool).toBe(DEFAULT_ANIMATION_TOOL);
  });

  it("maps first_frame and last_frame image cells into Seedance payload fields", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-frames-"));
    engine = createEngine({ rootDir, initialBookSlug: "runner-frames" });
    await engine.ready;

    const first = await engine.artifacts.create({ kind: "image", name: "first frame" });
    const last = await engine.artifacts.create({ kind: "image", name: "last frame" });
    expect(first.ok && last.ok).toBe(true);
    if (!first.ok || !last.ok) return;
    await engine.files.write(first.value.artifactId, "original.jpg", Buffer.from("first"));
    await engine.files.write(last.value.artifactId, "original.jpg", Buffer.from("last"));

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const firstCell = engine.notebooks.createCell({
      type: "image",
      slug: "img-first",
      slot: { row: 0, column: 0 },
      outputArtifactId: first.value.artifactId,
      inputs: { frameRole: "first" },
    });
    const lastCell = engine.notebooks.createCell({
      type: "image",
      slug: "img-last",
      slot: { row: 0, column: 1 },
      outputArtifactId: last.value.artifactId,
      inputs: { frameRole: "last" },
    });
    const animate = engine.notebooks.createCell({
      type: "generate_video",
      slug: "generate-video-animate",
      slot: { row: 0, column: 2 },
      prompt: "Camera push in",
      provider: "kie",
      model: "bytedance/seedance-2",
      operation: "image_to_video",
      tool: DEFAULT_ANIMATION_TOOL,
      inputs: { requiresConfirmation: true },
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [firstCell, lastCell, animate],
      edges: [
        engine.notebooks.createEdge({
          source: firstCell.id,
          target: animate.id,
          targetInput: "first_frame",
        }),
        engine.notebooks.createEdge({
          source: lastCell.id,
          target: animate.id,
          targetInput: "last_frame",
        }),
      ],
    };
    await engine.notebooks.write(document);

    const definition = {
      name: DEFAULT_ANIMATION_TOOL,
      schema: {
        book_id: {},
        prompt: {},
        first_frame_slug: {},
        last_frame_slug: {},
      },
    } as unknown as ToolDef;

    const args = modelArgs(
      definition,
      document,
      animate,
      engine.book.get().bookId,
      engine,
    );
    expect(args.first_frame_slug).toBe(`@${first.value.slug}`);
    expect(args.last_frame_slug).toBe(`@${last.value.slug}`);

    const prepared = await prepareNotebookGeneration(
      engine,
      document,
      animate,
      engine.book.get().bookId,
    );
    expect(prepared.tool).toBe(DEFAULT_ANIMATION_TOOL);
    expect(prepared.input.first_frame_slug).toBe(`@${first.value.slug}`);
    expect(prepared.input.last_frame_slug).toBe(`@${last.value.slug}`);
    await expect(
      prepareNotebookGeneration(
        engine,
        document,
        { ...animate, type: "generate_image" },
        engine.book.get().bookId,
      ),
    ).rejects.toThrow(/produces video, not generate_image/i);

    await expect(
      runNotebookCell(
        engine,
        engine.book.get().bookId,
        document.id,
        document,
        animate,
        { confirmPaid: false },
      ),
    ).rejects.toThrow(/requires confirmation/i);
  });

  it("propagates split output through a video asset cell before extraction", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-split-video-"));
    engine = createEngine({ rootDir, initialBookSlug: "runner-split-video" });
    await engine.ready;

    const clipPath = join(rootDir, "source.mp4");
    await makeClip(clipPath, 2);
    const sourceArtifact = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(sourceArtifact.ok).toBe(true);
    if (!sourceArtifact.ok) return;
    await engine.files.writeFromPath(
      sourceArtifact.value.artifactId,
      "original.mp4",
      clipPath,
    );

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const source = engine.notebooks.createCell({
      type: "video",
      slug: "vid-source",
      slot: { row: 0, column: 0 },
      outputArtifactId: sourceArtifact.value.artifactId,
    });
    const split = engine.notebooks.createCell({
      type: "split_video",
      slug: "split-video-action",
      slot: { row: 1, column: 0 },
      provider: "local",
      operation: "split_range",
      tool: "ffmpeg",
      inputs: { startSeconds: 0, endSeconds: 1 },
    });
    const video = engine.notebooks.createCell({
      type: "video",
      slug: "vid-split",
      slot: { row: 2, column: 0 },
    });
    const firstFrame = engine.notebooks.createCell({
      type: "image",
      slug: "img-first-frame",
      slot: { row: 3, column: 0 },
      inputs: { frameRole: "first" },
    });
    const lastFrame = engine.notebooks.createCell({
      type: "image",
      slug: "img-last-frame",
      slot: { row: 3, column: 1 },
      inputs: { frameRole: "last" },
    });
    const extractAudio = engine.notebooks.createCell({
      type: "extract_audio",
      slug: "extract-audio-scene",
      slot: { row: 3, column: 2 },
      provider: "local",
      operation: "extract_audio",
      tool: "ffmpeg",
    });
    const audio = engine.notebooks.createCell({
      type: "audio",
      slug: "aud-scene",
      slot: { row: 4, column: 2 },
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [source, split, video, firstFrame, lastFrame, extractAudio, audio],
      edges: [
        engine.notebooks.createEdge({
          source: source.id,
          target: split.id,
          targetInput: "video",
        }),
        engine.notebooks.createEdge({
          source: split.id,
          target: video.id,
          targetInput: "media",
        }),
        engine.notebooks.createEdge({
          source: video.id,
          target: firstFrame.id,
          targetInput: "segment",
        }),
        engine.notebooks.createEdge({
          source: video.id,
          target: lastFrame.id,
          targetInput: "segment",
        }),
        engine.notebooks.createEdge({
          source: video.id,
          target: extractAudio.id,
          targetInput: "video",
        }),
        engine.notebooks.createEdge({
          source: extractAudio.id,
          target: audio.id,
          targetInput: "media",
        }),
      ],
    };
    await engine.notebooks.write(document);

    const completedSplit = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      document.id,
      document,
      split,
    );
    const completedSplitCell = completedSplit.document.cells.find((cell) =>
      cell.id === split.id);
    const completedVideo = completedSplit.document.cells.find((cell) =>
      cell.id === video.id);
    expect(completedSplitCell?.outputArtifactId).toBe(completedSplit.outputArtifactId);
    expect(completedVideo?.outputArtifactId).toBe(completedSplit.outputArtifactId);
    expect(completedVideo?.inputs?.state).toBe("completed");
    const completedFirstFrame = completedSplit.document.cells.find((cell) =>
      cell.id === firstFrame.id);
    const completedLastFrame = completedSplit.document.cells.find((cell) =>
      cell.id === lastFrame.id);
    expect(completedFirstFrame?.outputArtifactId).toBe(
      completedSplitCell?.inputs?.firstFrameArtifactId,
    );
    expect(completedLastFrame?.outputArtifactId).toBe(
      completedSplitCell?.inputs?.lastFrameArtifactId,
    );
    expect(completedFirstFrame?.inputs?.state).toBe("completed");
    expect(completedLastFrame?.inputs?.state).toBe("completed");

    const pendingExtractAudio = completedSplit.document.cells.find((cell) =>
      cell.id === extractAudio.id);
    expect(pendingExtractAudio).toBeTruthy();
    if (!pendingExtractAudio) return;
    const completedExtractAudio = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      document.id,
      completedSplit.document,
      pendingExtractAudio,
    );
    const completedAudio = completedExtractAudio.document.cells.find((cell) =>
      cell.id === audio.id);
    expect(completedAudio?.outputArtifactId).toBe(
      completedExtractAudio.outputArtifactId,
    );
    expect(completedAudio?.inputs?.state).toBe("completed");
    expect(completedAudio?.inputs?.durationSeconds).toBeGreaterThan(0);
    const audioArtifact = engine.artifacts.get(
      completedExtractAudio.outputArtifactId,
    );
    expect(audioArtifact.ok && audioArtifact.value.kind).toBe("audio");
    const audioManifest = await engine.files.manifest(
      completedExtractAudio.outputArtifactId,
    );
    expect(audioManifest.ok && audioManifest.value.files.some((file) =>
      file.name === "original.m4a")).toBe(true);
    const listedAudio = (await buildAssetList(
      engine,
      engine.book.get().bookId,
    )).find((asset) =>
      asset.artifact_id === completedExtractAudio.outputArtifactId);
    expect(listedAudio?.media_url).toContain("original.m4a");
    expect(listedAudio?.status).toBe("ready");
    expect(listedAudio?.audio_info).toMatchObject({
      codec: "aac",
      sample_rate_hz: 44_100,
      channels: 2,
      channel_layout: "stereo",
      duration_seconds: expect.any(Number),
    });
  }, 90_000);

  it("rejects extract audio actions connected to non-video media", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-audio-input-"));
    engine = createEngine({ rootDir, initialBookSlug: "runner-audio-input" });
    await engine.ready;

    const sourceArtifact = await engine.artifacts.create({
      kind: "audio",
      name: "source audio",
    });
    expect(sourceArtifact.ok).toBe(true);
    if (!sourceArtifact.ok) return;
    await engine.files.write(
      sourceArtifact.value.artifactId,
      "original.m4a",
      Buffer.from("not-video"),
    );
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const source = engine.notebooks.createCell({
      type: "audio",
      slug: "aud-source",
      slot: { row: 0, column: 0 },
      outputArtifactId: sourceArtifact.value.artifactId,
    });
    const extractAudio = engine.notebooks.createCell({
      type: "extract_audio",
      slug: "extract-audio-source",
      slot: { row: 1, column: 0 },
      provider: "local",
      operation: "extract_audio",
      tool: "ffmpeg",
    });
    const output = engine.notebooks.createCell({
      type: "audio",
      slug: "aud-output",
      slot: { row: 2, column: 0 },
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [source, extractAudio, output],
      edges: [
        engine.notebooks.createEdge({
          source: source.id,
          target: extractAudio.id,
          targetInput: "video",
        }),
        engine.notebooks.createEdge({
          source: extractAudio.id,
          target: output.id,
          targetInput: "media",
        }),
      ],
    };
    await engine.notebooks.write(document);

    await expect(runNotebookCell(
      engine,
      engine.book.get().bookId,
      document.id,
      document,
      extractAudio,
    )).rejects.toThrow(/input must be video/i);
    const read = engine.notebooks.read(document.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.cells.find((cell) => cell.id === output.id)
      ?.outputArtifactId).toBeUndefined();
  });

  it("concats ordered video cells into a playable H264 and AAC output", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-concat-"));
    engine = createEngine({ rootDir, initialBookSlug: "runner-concat" });
    await engine.ready;

    const clipPath = join(rootDir, "clip.mp4");
    await makeClip(clipPath, 1);
    const clipA = await engine.artifacts.create({ kind: "video", name: "clip a" });
    const clipB = await engine.artifacts.create({ kind: "video", name: "clip b" });
    expect(clipA.ok && clipB.ok).toBe(true);
    if (!clipA.ok || !clipB.ok) return;
    await engine.files.writeFromPath(clipA.value.artifactId, "original.mp4", clipPath);
    await engine.files.writeFromPath(clipB.value.artifactId, "original.mp4", clipPath);

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const videoA = engine.notebooks.createCell({
      type: "video",
      slug: "vid-a",
      slot: { row: 0, column: 0 },
      outputArtifactId: clipA.value.artifactId,
    });
    const videoB = engine.notebooks.createCell({
      type: "video",
      slug: "vid-b",
      slot: { row: 0, column: 1 },
      outputArtifactId: clipB.value.artifactId,
    });
    const concat = engine.notebooks.createCell({
      type: "concat",
      slug: "concat-output",
      slot: { row: 0, column: 2 },
      provider: "local",
      operation: "concat_video",
      tool: "ffmpeg",
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [videoA, videoB, concat],
      edges: [
        engine.notebooks.createEdge({
          source: videoA.id,
          target: concat.id,
          targetInput: "clip:0",
        }),
        engine.notebooks.createEdge({
          source: videoB.id,
          target: concat.id,
          targetInput: "clip:1",
        }),
      ],
    };
    await engine.notebooks.write(document);

    const invalidSplice = engine.notebooks.createCell({
      type: "splice",
      slug: "splice-output",
      slot: { row: 1, column: 0 },
      operation: "splice_video",
      tool: "ffmpeg",
    });
    const invalidSpliceDocument: NotebookDocument = {
      ...document,
      cells: [...document.cells, invalidSplice],
      edges: [
        ...document.edges,
        engine.notebooks.createEdge({
          source: videoA.id,
          target: invalidSplice.id,
          targetInput: "first",
        }),
      ],
    };
    await expect(
      runNotebookCell(
        engine,
        engine.book.get().bookId,
        document.id,
        invalidSpliceDocument,
        invalidSplice,
      ),
    ).rejects.toThrow(/requires exactly one completed video on first and second/i);

    const completed = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      document.id,
      document,
      concat,
    );
    expect(completed.outputArtifactId).toBeTruthy();
    const completedCell = completed.document.cells.find((cell) => cell.id === concat.id);
    expect(completedCell?.type).toBe("concat");
    expect(completedCell?.outputArtifactId).toBe(completed.outputArtifactId);
    expect(completedCell?.inputs?.clipArtifactIds).toEqual([
      clipA.value.artifactId,
      clipB.value.artifactId,
    ]);

    const manifest = await engine.files.manifest(completed.outputArtifactId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.files.some((file) => file.name === "original.mp4")).toBe(true);

    const streams = engine.streams.list(completed.outputArtifactId);
    expect(streams.ok).toBe(true);
    if (!streams.ok) return;
    expect(streams.value.some((stream) =>
      stream.kind === "video" && stream.codec === "h264")).toBe(true);
    expect(streams.value.some((stream) =>
      stream.kind === "audio" && stream.codec === "aac")).toBe(true);
  }, 90_000);
});
