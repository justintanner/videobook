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
import { buildAssetList } from "../../server/src/tools/reconcile-project-work.js";
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
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("resolves generation tool from a generate_video cell before provider model id", () => {
    const tool = resolveNotebookGenerationTool({
      id: "019f0000-0000-7000-8000-000000000001",
      type: "generate_video",
      label: "Animate scene",
      slot: { row: 0, column: 0 },
      model: "bytedance/seedance-2",
      tool: DEFAULT_ANIMATION_TOOL,
    });
    expect(tool).toBe(DEFAULT_ANIMATION_TOOL);
  });

  it("maps numbered video inputs into generation reference fields", () => {
    const video = {
      id: "019f0000-0000-7000-8000-000000000010",
      type: "video" as const,
      label: "Reference video",
      slot: { row: 0, column: 0 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000011",
    };
    const animate = {
      id: "019f0000-0000-7000-8000-000000000012",
      type: "generate_video" as const,
      label: "Animate from reference",
      slot: { row: 1, column: 0 },
      prompt: "Follow the reference motion",
    };
    const document: NotebookDocument = {
      id: "019f0000-0000-7000-8000-000000000013",
      name: "References",
      cells: [video, animate],
      edges: [{
        id: "019f0000-0000-7000-8000-000000000014",
        source: video.id,
        target: animate.id,
        targetInput: "video_2",
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const definition = {
      name: DEFAULT_ANIMATION_TOOL,
      schema: {
        book_id: {},
        prompt: {},
        video_refs: {},
      },
    } as unknown as ToolDef;

    expect(modelArgs(definition, document, animate, "book-id").video_refs)
      .toEqual([`@${video.outputArtifactId}`]);
  });

  it("maps Kling motion control image and video inputs", () => {
    const image = {
      id: "019f0000-0000-7000-8000-000000000020",
      type: "image" as const,
      label: "Character image",
      slot: { row: 0, column: 0 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000021",
    };
    const video = {
      id: "019f0000-0000-7000-8000-000000000022",
      type: "video" as const,
      label: "Motion reference",
      slot: { row: 0, column: 1 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000023",
    };
    const generate = {
      id: "019f0000-0000-7000-8000-000000000024",
      type: "generate_video" as const,
      label: "Motion control video",
      slot: { row: 1, column: 0 },
      prompt: "Follow the reference performance",
    };
    const document: NotebookDocument = {
      id: "019f0000-0000-7000-8000-000000000025",
      name: "Motion Control",
      cells: [image, video, generate],
      edges: [
        {
          id: "019f0000-0000-7000-8000-000000000026",
          source: image.id,
          target: generate.id,
          targetInput: "image",
        },
        {
          id: "019f0000-0000-7000-8000-000000000027",
          source: video.id,
          target: generate.id,
          targetInput: "video",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const definition = {
      name: "generate_kie_kling_3_0_motion_control",
      schema: {
        book_id: {},
        prompt: {},
        character_image_refs: {},
        motion_video_refs: {},
      },
    } as unknown as ToolDef;

    expect(modelArgs(definition, document, generate, "book-id")).toMatchObject({
      character_image_refs: [`@${image.outputArtifactId}`],
      motion_video_refs: [`@${video.outputArtifactId}`],
    });
  });

  it("accepts Extract Frame cells as generation image sources", () => {
    const extractFrame = {
      id: "019f0000-0000-7000-8000-000000000030",
      type: "extract_frame" as const,
      label: "Extract source frame",
      slot: { row: 0, column: 0 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000031",
    };
    const image = {
      id: "019f0000-0000-7000-8000-000000000032",
      type: "image" as const,
      label: "Source image",
      slot: { row: 1, column: 0 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000033",
    };
    const generate = {
      id: "019f0000-0000-7000-8000-000000000034",
      type: "generate_image" as const,
      label: "Generate from source image",
      slot: { row: 2, column: 0 },
    };
    const document: NotebookDocument = {
      id: "019f0000-0000-7000-8000-000000000035",
      name: "Extracted image source",
      cells: [extractFrame, image, generate],
      edges: [
        {
          id: "019f0000-0000-7000-8000-000000000036",
          source: extractFrame.id,
          target: generate.id,
          targetInput: "image",
        },
        {
          id: "019f0000-0000-7000-8000-000000000037",
          source: image.id,
          target: generate.id,
          targetInput: "image",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const definition = {
      name: "generate_test_image",
      schema: {
        book_id: {},
        prompt: {},
        image_refs: {},
      },
    } as unknown as ToolDef;

    expect(modelArgs(definition, document, generate, "book-id").image_refs)
      .toEqual([
        `@${extractFrame.outputArtifactId}`,
        `@${image.outputArtifactId}`,
      ]);
  });

  it("maps first_frame and last_frame image cells into Seedance payload fields", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-frames-"));
    engine = createEngine({ rootDir, initialBookName: "runner-frames" });
    await engine.ready;

    const first = await engine.artifacts.create({ kind: "image", label: "First frame" });
    const last = await engine.artifacts.create({ kind: "image", label: "Last frame" });
    expect(first.ok && last.ok).toBe(true);
    if (!first.ok || !last.ok) return;
    await engine.files.write(first.value.artifactId, "original.jpg", Buffer.from("first"));
    await engine.files.write(last.value.artifactId, "original.jpg", Buffer.from("last"));

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const firstCell = engine.notebooks.createCell({
      type: "image",
      label: "First frame",
      slot: { row: 0, column: 0 },
      outputArtifactId: first.value.artifactId,
      inputs: { frameRole: "first" },
    });
    const lastCell = engine.notebooks.createCell({
      type: "image",
      label: "Last frame",
      slot: { row: 0, column: 1 },
      outputArtifactId: last.value.artifactId,
      inputs: { frameRole: "last" },
    });
    const animate = engine.notebooks.createCell({
      type: "generate_video",
      label: "Animate scene",
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
        first_frame_ref: {},
        last_frame_ref: {},
      },
    } as unknown as ToolDef;

    const args = modelArgs(
      definition,
      document,
      animate,
      engine.book.get().bookId,
      engine,
    );
    expect(args.first_frame_ref).toBe(`@${first.value.artifactId}`);
    expect(args.last_frame_ref).toBe(`@${last.value.artifactId}`);

    const prepared = await prepareNotebookGeneration(
      engine,
      document,
      animate,
      engine.book.get().bookId,
    );
    expect(prepared.tool).toBe(DEFAULT_ANIMATION_TOOL);
    expect(prepared.input.first_frame_ref).toBe(`@${first.value.artifactId}`);
    expect(prepared.input.last_frame_ref).toBe(`@${last.value.artifactId}`);
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
    engine = createEngine({ rootDir, initialBookName: "runner-split-video" });
    await engine.ready;

    const clipPath = join(rootDir, "source.mp4");
    await makeClip(clipPath, 2);
    const sourceArtifact = await engine.artifacts.create({
      kind: "video",
      label: "Source video",
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
      label: "Source video",
      slot: { row: 0, column: 0 },
      outputArtifactId: sourceArtifact.value.artifactId,
    });
    const split = engine.notebooks.createCell({
      type: "split_video",
      label: "Split source",
      slot: { row: 1, column: 0 },
      provider: "local",
      operation: "split_range",
      tool: "ffmpeg",
      inputs: { startSeconds: 0, endSeconds: 1 },
    });
    const video = engine.notebooks.createCell({
      type: "video",
      label: "Split video",
      slot: { row: 2, column: 0 },
    });
    const firstFrame = engine.notebooks.createCell({
      type: "image",
      label: "First frame",
      slot: { row: 3, column: 0 },
      inputs: { frameRole: "first" },
    });
    const lastFrame = engine.notebooks.createCell({
      type: "image",
      label: "Last frame",
      slot: { row: 3, column: 1 },
      inputs: { frameRole: "last" },
    });
    const extractAudio = engine.notebooks.createCell({
      type: "extract_audio",
      label: "Extract scene audio",
      slot: { row: 3, column: 2 },
      provider: "local",
      operation: "extract_audio",
      tool: "ffmpeg",
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [source, split, video, firstFrame, lastFrame, extractAudio],
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
      cell.id === extractAudio.id);
    expect(completedExtractAudio.document.cells.some((cell) =>
      cell.type === "audio")).toBe(false);
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

    const extractAudioRerun = completedExtractAudio.document.cells.find((cell) =>
      cell.id === extractAudio.id);
    expect(extractAudioRerun).toBeTruthy();
    if (!extractAudioRerun) return;
    const rerun = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      document.id,
      completedExtractAudio.document,
      extractAudioRerun,
    );
    const rerunAudio = rerun.document.cells.find((cell) =>
      cell.id === extractAudio.id);
    expect(rerun.outputArtifactId).not.toBe(
      completedExtractAudio.outputArtifactId,
    );
    expect(rerunAudio?.outputArtifactId).toBe(rerun.outputArtifactId);
    expect(rerunAudio?.inputs?.outputVersionArtifactIds).toEqual([
      completedExtractAudio.outputArtifactId,
      rerun.outputArtifactId,
    ]);
  }, 90_000);

  it("lands extract_frame artifacts on the extract cell itself", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-extract-frame-"));
    engine = createEngine({ rootDir, initialBookName: "runner-extract-frame" });
    await engine.ready;

    const clipPath = join(rootDir, "source.mp4");
    await makeClip(clipPath, 3);
    const sourceArtifact = await engine.artifacts.create({
      kind: "video",
      label: "Source video",
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
      label: "Source video",
      slot: { row: 0, column: 0 },
      outputArtifactId: sourceArtifact.value.artifactId,
    });
    const extractFrame = engine.notebooks.createCell({
      type: "extract_frame",
      label: "Extract source frame",
      slot: { row: 1, column: 0 },
      provider: "local",
      operation: "extract_frame",
      tool: "ffmpeg",
      inputs: { frameMode: "first" },
    });
    const occupiedBelow = engine.notebooks.createCell({
      type: "image",
      label: "Placeholder image",
      slot: { row: 2, column: 0 },
    });
    let current: NotebookDocument = {
      ...notebook.value,
      cells: [source, extractFrame, occupiedBelow],
      edges: [
        engine.notebooks.createEdge({
          source: source.id,
          target: extractFrame.id,
          targetInput: "video",
        }),
      ],
    };
    await engine.notebooks.write(current);

    const runConfigured = async (
      frameMode: "first" | "time" | "last",
      timestampSeconds?: number,
    ) => {
      current = {
        ...current,
        cells: current.cells.map((cell) =>
          cell.id === extractFrame.id
            ? {
                ...cell,
                inputs: {
                  ...(cell.inputs ?? {}),
                  frameMode,
                  ...(timestampSeconds === undefined
                    ? {}
                    : { timestampSeconds }),
                },
              }
            : cell),
      };
      const written = await engine!.notebooks.write(current);
      expect(written.ok).toBe(true);
      const action = current.cells.find((cell) =>
        cell.id === extractFrame.id);
      expect(action).toBeTruthy();
      if (!action) throw new Error("Extract Frame action missing");
      const completed = await runNotebookCell(
        engine!,
        engine!.book.get().bookId,
        current.id,
        current,
        action,
      );
      current = completed.document;
      return completed;
    };

    const first = await runConfigured("first");
    const firstExtract = first.document.cells.find((cell) =>
      cell.id === extractFrame.id);
    expect(firstExtract).toMatchObject({
      type: "extract_frame",
      outputArtifactId: first.outputArtifactId,
      inputs: {
        frameMode: "first",
        atSeconds: 0,
        outputVersionArtifactIds: [first.outputArtifactId],
        state: "completed",
      },
    });
    expect(first.document.edges.filter((edge) =>
      edge.source === extractFrame.id && edge.targetInput === "media"))
      .toHaveLength(0);
    expect(first.document.cells.filter((cell) => cell.type === "image"))
      .toHaveLength(1);

    const repeatedFirst = await runConfigured("first");
    const repeatedFirstExtract = repeatedFirst.document.cells.find((cell) =>
      cell.id === extractFrame.id);
    expect(repeatedFirstExtract).toMatchObject({
      outputArtifactId: repeatedFirst.outputArtifactId,
      inputs: {
        frameMode: "first",
        outputVersionArtifactIds: [
          first.outputArtifactId,
          repeatedFirst.outputArtifactId,
        ],
      },
    });

    const timed = await runConfigured("time", 1.25);
    const timedExtract = timed.document.cells.find((cell) =>
      cell.id === extractFrame.id);
    expect(timedExtract).toMatchObject({
      outputArtifactId: timed.outputArtifactId,
      inputs: {
        frameMode: "time",
        timestampSeconds: 1.25,
        atSeconds: 1.25,
        outputVersionArtifactIds: [
          first.outputArtifactId,
          repeatedFirst.outputArtifactId,
          timed.outputArtifactId,
        ],
      },
    });

    const last = await runConfigured("last");
    const lastExtract = last.document.cells.find((cell) =>
      cell.id === extractFrame.id);
    expect(lastExtract?.outputArtifactId).toBe(last.outputArtifactId);
    expect(Number(lastExtract?.inputs?.atSeconds)).toBeGreaterThan(2.9);
    expect(lastExtract?.inputs?.frameMode).toBe("last");
    expect(lastExtract?.inputs?.outputVersionArtifactIds).toEqual([
      first.outputArtifactId,
      repeatedFirst.outputArtifactId,
      timed.outputArtifactId,
      last.outputArtifactId,
    ]);
    expect(last.document.cells.filter((cell) => cell.type === "image"))
      .toHaveLength(1);
    expect(last.document.edges.filter((edge) =>
      edge.source === extractFrame.id && edge.targetInput === "media"))
      .toHaveLength(0);
    expect(last.document.cells.some((cell) => cell.type === "audio")).toBe(false);

    const manifest = await engine.files.manifest(last.outputArtifactId);
    expect(manifest.ok && manifest.value.files.some((file) =>
      file.name === "original.jpg")).toBe(true);
    const metadata = await engine.metadata.artifacts.read<{
      origin?: string;
      sourceArtifactId?: string;
      frameMode?: string;
      atSeconds?: number;
    }>(last.outputArtifactId, "original");
    expect(metadata.ok && metadata.value).toMatchObject({
      origin: "extract_frame",
      sourceArtifactId: sourceArtifact.value.artifactId,
      frameMode: "last",
      atSeconds: expect.any(Number),
    });
    const listed = (await buildAssetList(
      engine,
      engine.book.get().bookId,
    )).find((asset) => asset.artifact_id === last.outputArtifactId);
    expect(listed?.type).toBe("image");
    expect(listed?.media_url).toContain("original.jpg");
  }, 90_000);

  it("rejects extract audio actions connected to non-video media", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-audio-input-"));
    engine = createEngine({ rootDir, initialBookName: "runner-audio-input" });
    await engine.ready;

    const sourceArtifact = await engine.artifacts.create({
      kind: "audio",
      label: "Source audio",
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
      label: "Source audio",
      slot: { row: 0, column: 0 },
      outputArtifactId: sourceArtifact.value.artifactId,
    });
    const extractAudio = engine.notebooks.createCell({
      type: "extract_audio",
      label: "Extract source audio",
      slot: { row: 1, column: 0 },
      provider: "local",
      operation: "extract_audio",
      tool: "ffmpeg",
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [source, extractAudio],
      edges: [
        engine.notebooks.createEdge({
          source: source.id,
          target: extractAudio.id,
          targetInput: "video",
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
    expect(read.value.execution?.[extractAudio.id]?.status).toBe("error");
    expect(read.value.cells.some((cell) => cell.type === "audio" && cell.id !== source.id))
      .toBe(false);
  });

  it("concats ordered video cells into a playable H264 and AAC output", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-concat-"));
    engine = createEngine({ rootDir, initialBookName: "runner-concat" });
    await engine.ready;

    const clipPath = join(rootDir, "clip.mp4");
    await makeClip(clipPath, 1);
    const clipA = await engine.artifacts.create({ kind: "video", label: "Clip A" });
    const clipB = await engine.artifacts.create({ kind: "video", label: "Clip B" });
    expect(clipA.ok && clipB.ok).toBe(true);
    if (!clipA.ok || !clipB.ok) return;
    await engine.files.writeFromPath(clipA.value.artifactId, "original.mp4", clipPath);
    await engine.files.writeFromPath(clipB.value.artifactId, "original.mp4", clipPath);

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const videoA = engine.notebooks.createCell({
      type: "video",
      label: "Clip A",
      slot: { row: 0, column: 0 },
      outputArtifactId: clipA.value.artifactId,
    });
    const videoB = engine.notebooks.createCell({
      type: "video",
      label: "Clip B",
      slot: { row: 0, column: 1 },
      outputArtifactId: clipB.value.artifactId,
    });
    const concat = engine.notebooks.createCell({
      type: "concat",
      label: "Concat clips",
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
      label: "Splice clips",
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
    expect((await engine.notebooks.write(invalidSpliceDocument)).ok).toBe(true);
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
