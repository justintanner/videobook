import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import {
  DANCING_FIXTURE_OWNER,
  DANCING_FIXTURE_VERSION,
  DANCING_MOTION_DURATION_SECONDS,
  seedDancingWorkflow,
} from "../../server/src/dancing-workflow.js";
import { FFMPEG, probeVideo } from "../../server/src/ffmpeg.js";
import {
  notebookCellIsStale,
  prepareNotebookGeneration,
} from "../../server/src/jobs/run-notebook.js";

const execFileAsync = promisify(execFile);

describe("Dancing workflow fixture", () => {
  let rootDir: string | undefined;
  let mediaDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) {
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
    if (mediaDir) {
      await rm(mediaDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  });

  it("builds explicit image and video generation output pairs", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-dancing-"));
    mediaDir = await mkdtemp(join(tmpdir(), "videobook-dancing-media-"));
    const sourcePath = join(mediaDir, "source.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc2=s=360x640:r=6:d=12",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000:duration=12",
      "-map", "0:v",
      "-map", "1:a",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      sourcePath,
    ]);
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "dancing" });
    await engine.ready;
    const created = await engine.notebooks.create("Main");
    expect(created.ok).toBe(true);

    const seeded = await seedDancingWorkflow(engine, {
      sourceVideoPath: sourcePath,
      kittenImagePath: resolve("public/dancing-kittens-first-frame.png"),
    });
    const owned = seeded.cells.filter((cell) =>
      cell.inputs?.fixtureOwner === DANCING_FIXTURE_OWNER);
    expect(owned).toHaveLength(6);
    expect(seeded.edges).toHaveLength(6);
    expect(seeded.fixture).toEqual(expect.objectContaining({
      version: DANCING_FIXTURE_VERSION,
      owner: DANCING_FIXTURE_OWNER,
      motionDurationSeconds: DANCING_MOTION_DURATION_SECONDS,
      noPaidCalls: true,
    }));

    const source = owned.find((cell) =>
      cell.inputs?.workflowRole === "download-video");
    const extract = owned.find((cell) =>
      cell.inputs?.workflowRole === "extract-first-frame");
    const kittens = owned.find((cell) =>
      cell.inputs?.workflowRole === "kittens-freeway");
    const kittenOutput = owned.find((cell) =>
      cell.inputs?.workflowRole === "kittens-freeway-output");
    const motion = owned.find((cell) =>
      cell.inputs?.workflowRole === "kling-omni-transformation");
    const motionOutput = owned.find((cell) =>
      cell.inputs?.workflowRole === "kling-omni-transformation-output");
    expect(source?.inputs).toEqual(expect.objectContaining({
      sourceOperation: "download_video",
      selectedRangeSeconds: [0, 10],
      state: "completed",
    }));
    expect(extract).toEqual(expect.objectContaining({
      type: "image",
      outputArtifactId: expect.any(String),
    }));
    expect(extract?.inputs).toEqual(expect.objectContaining({
      mediaRole: "extract-frame-output",
      atSeconds: 0.1,
      frameMode: "first",
      state: "completed",
    }));
    expect(kittens).toEqual(expect.objectContaining({
      type: "generate_image",
      tool: "generate_image",
      provider: "kie",
      model: "kie:nano-banana-pro",
    }));
    expect(kittens?.prompt).toContain("two kittens");
    expect(kittens?.prompt).toContain("freeway");
    expect(kittens?.outputArtifactId).toBeUndefined();
    expect(kittens?.slot).toEqual({ row: 2, column: 1 });
    expect(kittenOutput).toEqual(expect.objectContaining({
      type: "image",
      slot: { row: 3, column: 1 },
      inputs: expect.objectContaining({
        mediaRole: "generate-image-output",
        producerCellId: kittens?.id,
        state: "completed",
      }),
    }));
    expect(kittenOutput?.outputArtifactId).toBeTruthy();
    expect(seeded.execution?.[kittens!.id]).toEqual(expect.objectContaining({
      status: "completed",
      outputArtifactId: kittenOutput?.outputArtifactId,
    }));
    expect(motion).toEqual(expect.objectContaining({
      type: "generate_video",
      operation: "edit_video",
      tool: "generate_video",
      provider: "kie",
      model: "kie:kling-3.0-omni/transformation",
    }));
    expect(motion?.inputs).toEqual(expect.objectContaining({
      generationSettings: {
        resolution: "720p",
        aspect_ratio: "9:16",
        duration: "10",
      },
      requiresConfirmation: true,
      state: "pending",
    }));
    expect(motionOutput).toEqual(expect.objectContaining({
      type: "video",
      inputs: expect.objectContaining({
        mediaRole: "generate-video-output",
        producerCellId: motion?.id,
        state: "pending",
      }),
    }));
    expect(motionOutput?.outputArtifactId).toBeUndefined();
    expect(seeded.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: source?.id,
        target: extract?.id,
        targetInput: "segment",
      }),
      expect.objectContaining({
        source: extract?.id,
        target: kittens?.id,
        targetInput: "input",
      }),
      expect.objectContaining({
        source: kittens?.id,
        target: kittenOutput?.id,
        targetInput: "media",
      }),
      expect.objectContaining({
        source: kittenOutput?.id,
        target: motion?.id,
        targetInput: "image",
      }),
      expect.objectContaining({
        source: source?.id,
        target: motion?.id,
        targetInput: "video",
      }),
      expect.objectContaining({
        source: motion?.id,
        target: motionOutput?.id,
        targetInput: "media",
      }),
    ]));
    expect(seeded.edges.some((edge) =>
      edge.source === extract?.id
      && edge.target === kittens?.id
      && edge.targetInput === "media")).toBe(false);
    expect(seeded.edges.some((edge) =>
      edge.source === kittens?.id && edge.target === motion?.id)).toBe(false);
    if (!source?.outputArtifactId || !motion) {
      throw new Error("Dancing fixture source or motion cell is missing");
    }
    const sourceManifest = await engine.files.manifest(source.outputArtifactId);
    expect(sourceManifest.ok).toBe(true);
    if (!sourceManifest.ok) return;
    const sourceVideo = sourceManifest.value.files.find((file) =>
      file.name === "original.mp4");
    expect(sourceVideo).toBeTruthy();
    if (!sourceVideo) return;
    const probe = await probeVideo(join(sourceManifest.value.path, sourceVideo.name));
    expect(probe.duration).toBeGreaterThanOrEqual(9.9);
    expect(probe.duration).toBeLessThanOrEqual(10.1);
    const prepared = await prepareNotebookGeneration(
      engine,
      seeded,
      motion,
      engine.book.get().bookId,
    );
    expect(prepared).toMatchObject({
      tool: "generate_video",
      provider: "kie",
      model: "kie:kling-3.0-omni/transformation",
    });
    expect(prepared.input).toEqual(expect.objectContaining({
      model: "kie:kling-3.0-omni/transformation",
      options: {
        resolution: "720p",
        aspect_ratio: "9:16",
        duration: "10",
      },
      refs: {
        image: [kittenOutput?.outputArtifactId],
        video: [source.outputArtifactId],
      },
    }));
    if (!extract || !kittens) {
      throw new Error("Dancing fixture preparation cells are missing");
    }
    expect(notebookCellIsStale(engine, seeded, extract)).toBe(false);
    expect(notebookCellIsStale(engine, seeded, kittens)).toBe(false);
    expect(notebookCellIsStale(engine, seeded, motion)).toBe(true);
    const firstIds = owned.map((cell) => cell.id);
    const firstHead = engine.head;
    const repeated = await seedDancingWorkflow(engine, {
      sourceVideoPath: sourcePath,
      kittenImagePath: resolve("public/dancing-kittens-first-frame.png"),
    });
    expect(repeated.cells.filter((cell) =>
      cell.inputs?.fixtureOwner === DANCING_FIXTURE_OWNER).map((cell) => cell.id))
      .toEqual(firstIds);
    expect(engine.head).toBe(firstHead);
  }, 90_000);
});
