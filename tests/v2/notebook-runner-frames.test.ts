import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  type Engine,
  type NotebookCell,
  type NotebookDocument,
} from "videobook-engine";
import { FFMPEG } from "../../server/src/ffmpeg.js";
import {
  prepareNotebookGeneration,
  resolveNotebookGenerationTool,
  runNotebookCell,
} from "../../server/src/jobs/run-notebook.js";
import { frameAspectRatio } from "../../server/src/media/frame-options.js";
import { previewGeneration } from "../../server/src/media/preview.js";
import { DEFAULT_ANIMATION_MODEL } from "../../server/src/notebook-action-catalog.js";
import { buildAssetList } from "../../server/src/tools/reconcile-project-work.js";
import { testBudget } from "../../server/src/test-budget.js";

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

  async function openEngine(name: string): Promise<Engine> {
    rootDir = await mkdtemp(join(tmpdir(), `vb-${name}-`));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: name });
    await engine.ready;
    return engine;
  }

  async function prepareInput(
    document: NotebookDocument,
    cell: NotebookCell,
  ): Promise<Record<string, unknown>> {
    const opened = await openEngine("runner-refs");
    const prepared = await prepareNotebookGeneration(opened, document, cell, "book-id");
    return prepared.input;
  }

  it("resolves generation tool from a generate_video cell model", () => {
    expect(resolveNotebookGenerationTool({
      id: "019f0000-0000-7000-8000-000000000001",
      type: "generate_video",
      label: "Animate scene",
      slot: { row: 0, column: 0 },
      model: DEFAULT_ANIMATION_MODEL,
      tool: "generate_video",
    })).toBe("generate_video");
    expect(resolveNotebookGenerationTool({
      id: "019f0000-0000-7000-8000-000000000002",
      type: "generate_image",
      label: "Scene",
      slot: { row: 0, column: 1 },
      model: "kie:nano-banana-2-1",
    })).toBe("generate_image");
  });

  it("maps numbered video inputs into generation reference fields", async () => {
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
      model: DEFAULT_ANIMATION_MODEL,
      tool: "generate_video",
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

    const input = await prepareInput(document, animate);
    expect(input.refs).toEqual({ video: [video.outputArtifactId] });
    expect(input.mode).toBe("r2v");
  });

  it("maps a source clip plus three identity stills into Seedance r2v refs", async () => {
    const video = {
      id: "019f0000-0000-7000-8000-000000000110",
      type: "video" as const,
      label: "Source clip",
      slot: { row: 0, column: 0 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000111",
    };
    const stills = [0, 1, 2].map((index) => ({
      id: `019f0000-0000-7000-8000-00000000012${index}`,
      type: "image" as const,
      label: `Actor ${index + 1}`,
      slot: { row: 0, column: index + 1 },
      outputArtifactId: `019f0000-0000-7000-8000-00000000013${index}`,
    }));
    const generate = {
      id: "019f0000-0000-7000-8000-000000000140",
      type: "generate_video" as const,
      label: "Replace actors",
      slot: { row: 1, column: 0 },
      prompt: "Replace the three actors",
      model: DEFAULT_ANIMATION_MODEL,
      tool: "generate_video",
    };
    const document: NotebookDocument = {
      id: "019f0000-0000-7000-8000-000000000141",
      name: "Actor replacement",
      cells: [video, ...stills, generate],
      edges: [
        {
          id: "019f0000-0000-7000-8000-000000000150",
          source: video.id,
          target: generate.id,
          targetInput: "video",
        },
        ...stills.map((still, index) => ({
          id: `019f0000-0000-7000-8000-00000000015${index + 1}`,
          source: still.id,
          target: generate.id,
          targetInput: "image",
        })),
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const input = await prepareInput(document, generate);
    expect(input).toMatchObject({
      model: DEFAULT_ANIMATION_MODEL,
      mode: "r2v",
      refs: {
        video: [video.outputArtifactId],
        image: stills.map((still) => still.outputArtifactId),
      },
    });
  });

  it("orders Qwen 3 image refs by named image/image_2/image_3 slots", async () => {
    const smoke = {
      id: "019f0000-0000-7000-8000-000000000210",
      type: "image" as const,
      label: "Smoke",
      slot: { row: 0, column: 2 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000211",
    };
    const first = {
      id: "019f0000-0000-7000-8000-000000000212",
      type: "image" as const,
      label: "Person A",
      slot: { row: 0, column: 0 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000213",
    };
    const second = {
      id: "019f0000-0000-7000-8000-000000000214",
      type: "image" as const,
      label: "Person B",
      slot: { row: 0, column: 1 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000215",
    };
    const generate = {
      id: "019f0000-0000-7000-8000-000000000216",
      type: "generate_image" as const,
      label: "Qwen edit",
      slot: { row: 1, column: 0 },
      prompt: "in the smoke of @019f0000-0000-7000-8000-000000000211",
      model: "kie:qwen3/image-to-image",
      tool: "generate_image",
    };
    const document: NotebookDocument = {
      id: "019f0000-0000-7000-8000-000000000217",
      name: "Qwen slot order",
      cells: [smoke, first, second, generate],
      edges: [
        {
          id: "019f0000-0000-7000-8000-000000000218",
          source: smoke.id,
          target: generate.id,
          targetInput: "image_3",
        },
        {
          id: "019f0000-0000-7000-8000-000000000219",
          source: first.id,
          target: generate.id,
          targetInput: "image",
        },
        {
          id: "019f0000-0000-7000-8000-00000000021a",
          source: second.id,
          target: generate.id,
          targetInput: "image_2",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const input = await prepareInput(document, generate);
    expect(input.refs).toEqual({
      image: [
        first.outputArtifactId,
        second.outputArtifactId,
        smoke.outputArtifactId,
      ],
    });
  });

  it("maps a Wan generic image plus last frame into frame refs", async () => {
    const first = {
      id: "019f0000-0000-7000-8000-000000000220",
      type: "image" as const,
      label: "First frame",
      slot: { row: 0, column: 0 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000221",
    };
    const last = {
      id: "019f0000-0000-7000-8000-000000000222",
      type: "image" as const,
      label: "Last frame",
      slot: { row: 0, column: 1 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000223",
    };
    const generate = {
      id: "019f0000-0000-7000-8000-000000000224",
      type: "generate_video" as const,
      label: "Wan Prime",
      slot: { row: 1, column: 0 },
      prompt: "Walk away from the camera",
      model: "kie:wan/3-0-video-prime",
      tool: "generate_video",
      inputs: { generationMode: "default" },
    };
    const document: NotebookDocument = {
      id: "019f0000-0000-7000-8000-000000000225",
      name: "Wan frames",
      cells: [first, last, generate],
      edges: [
        {
          id: "019f0000-0000-7000-8000-000000000226",
          source: first.id,
          target: generate.id,
          targetInput: "image",
        },
        {
          id: "019f0000-0000-7000-8000-000000000227",
          source: last.id,
          target: generate.id,
          targetInput: "last_frame",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const frameRefs = {
      first_frame: [first.outputArtifactId],
      last_frame: [last.outputArtifactId],
    };

    const configured = await prepareInput(document, generate);
    expect(configured.refs).toEqual(frameRefs);
    expect(configured.mode).toBe("i2v");
    engine?.close();
    await rm(rootDir!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    const unconfigured = await prepareInput(document, { ...generate, inputs: undefined });
    expect(unconfigured.refs).toEqual(frameRefs);
    expect(unconfigured.mode).toBe("i2v");
  });

  function klingDocument(model: string) {
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
      model,
      tool: "generate_video",
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
    return {
      document,
      generate,
      refs: { image: [image.outputArtifactId], video: [video.outputArtifactId] },
    };
  }

  it("maps Kling motion control image and video inputs", async () => {
    const { document, generate, refs } = klingDocument("kie:kling-3.0/motion-control");
    const opened = await openEngine("runner-kling");
    const prepared = await prepareNotebookGeneration(opened, document, generate, "book-id");
    expect(prepared.model).toBe("kie:kling-3.0/motion-control");
    expect(prepared.input.refs).toEqual(refs);
  });

  it("maps Kling Omni transformation image and video inputs", async () => {
    const { document, generate, refs } = klingDocument("kie:kling-3.0-omni/transformation");
    const opened = await openEngine("runner-kling-omni");
    const prepared = await prepareNotebookGeneration(opened, document, generate, "book-id");
    expect(prepared.model).toBe("kie:kling-3.0-omni/transformation");
    expect(prepared.input.refs).toEqual(refs);
  });

  it("accepts extracted-frame image cells as generation image sources", async () => {
    const extractedFrame = {
      id: "019f0000-0000-7000-8000-000000000030",
      type: "image" as const,
      label: "Extracted source frame",
      slot: { row: 0, column: 0 },
      outputArtifactId: "019f0000-0000-7000-8000-000000000031",
      inputs: { mediaRole: "extract-frame-output", frameMode: "first" },
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
      prompt: "Blend both sources",
      model: "kie:nano-banana-pro",
      tool: "generate_image",
    };
    const document: NotebookDocument = {
      id: "019f0000-0000-7000-8000-000000000035",
      name: "Extracted image source",
      cells: [extractedFrame, image, generate],
      edges: [
        {
          id: "019f0000-0000-7000-8000-000000000036",
          source: extractedFrame.id,
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

    const input = await prepareInput(document, generate);
    expect(input.refs).toEqual({
      image: [
        extractedFrame.outputArtifactId,
        image.outputArtifactId,
      ],
    });
  });

  it("maps first_frame and last_frame image cells into Seedance payload fields", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-frames-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "runner-frames" });
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
      model: DEFAULT_ANIMATION_MODEL,
      operation: "image_to_video",
      tool: "generate_video",
      inputs: { requiresConfirmation: true, generationSettings: { aspect_ratio: "9:16" } },
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

    const prepared = await prepareNotebookGeneration(
      engine,
      document,
      animate,
      engine.book.get().bookId,
    );
    expect(prepared.tool).toBe("generate_video");
    expect(prepared.model).toBe(DEFAULT_ANIMATION_MODEL);
    expect(prepared.provider).toBe("kie");
    expect(prepared.input.refs).toEqual({
      first_frame: [first.value.artifactId],
      last_frame: [last.value.artifactId],
    });
    expect(prepared.input.mode).toBe("i2v");
    expect(frameAspectRatio(DEFAULT_ANIMATION_MODEL, prepared.input)).toBe("adaptive");
    const preview = previewGeneration(prepared.input);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(JSON.stringify(preview.preview.payload)).toContain("\"aspect_ratio\":\"adaptive\"");
    await expect(
      prepareNotebookGeneration(
        engine,
        document,
        { ...animate, type: "generate_image" },
        engine.book.get().bookId,
      ),
    ).rejects.toThrow(/generates video, not generate_image/i);

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
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "runner-split-video" });
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
    expect(completedAudio?.type).toBe("audio");
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
  }, testBudget(90_000));

  it("rejects extract audio actions connected to non-video media", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-audio-input-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "runner-audio-input" });
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
    )).rejects.toThrow(/video input|input must be video/i);
    const read = engine.notebooks.read(document.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.execution?.[extractAudio.id]?.status).toBe("error");
    expect(read.value.execution?.[extractAudio.id]?.status).toBe("error");
  });

  it("concats ordered video cells into a playable H264 and AAC output", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-concat-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "runner-concat" });
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
  }, testBudget(90_000));
});
