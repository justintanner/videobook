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
  modelArgs,
  notebookCellIsStale,
} from "../../server/src/jobs/run-notebook.js";
import { generateKling30MotionControlVideoDef } from "../../server/src/tools/generate-kling30-motion-control-video.js";

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
    engine = createEngine({ rootDir, initialBookName: "dancing" });
    await engine.ready;
    const created = await engine.notebooks.create("Main");
    expect(created.ok).toBe(true);

    const seeded = await seedDancingWorkflow(engine, {
      sourceVideoPath: sourcePath,
      kittenImagePath: resolve("public/dancing-kittens-first-frame.png"),
    });
    const owned = seeded.cells.filter((cell) =>
      cell.inputs?.fixtureOwner === DANCING_FIXTURE_OWNER);
    expect(owned).toHaveLength(7);
    expect(seeded.edges).toHaveLength(7);
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
    const frame = owned.find((cell) =>
      cell.inputs?.workflowRole === "first-frame-output");
    const kittens = owned.find((cell) =>
      cell.inputs?.workflowRole === "kittens-freeway");
    const kittenOutput = owned.find((cell) =>
      cell.inputs?.workflowRole === "kittens-freeway-output");
    const motion = owned.find((cell) =>
      cell.inputs?.workflowRole === "kling-motion-control");
    const motionOutput = owned.find((cell) =>
      cell.inputs?.workflowRole === "kling-motion-control-output");
    expect(source?.inputs).toEqual(expect.objectContaining({
      sourceOperation: "download_video",
      selectedRangeSeconds: [0, 10],
      state: "completed",
    }));
    expect(extract).toEqual(expect.objectContaining({
      type: "extract_frame",
      operation: "extract_frame",
      tool: "ffmpeg",
      outputArtifactId: frame?.outputArtifactId,
    }));
    expect(extract?.inputs).toEqual(expect.objectContaining({
      atSeconds: 0.1,
      frameMode: "first",
      state: "completed",
    }));
    expect(kittens).toEqual(expect.objectContaining({
      type: "generate_image",
      tool: "generate_google_flow_nano_banana_pro_image",
      model: "googleflow/image/nano-banana-pro",
    }));
    expect(kittens?.prompt).toContain("two kittens");
    expect(kittens?.prompt).toContain("freeway");
    expect(kittenOutput).toEqual(expect.objectContaining({
      type: "image",
      outputArtifactId: kittens?.outputArtifactId,
      inputs: expect.objectContaining({
        mediaRole: "generate-image-output",
        producerCellId: kittens?.id,
        state: "completed",
      }),
    }));
    expect(motion).toEqual(expect.objectContaining({
      type: "generate_video",
      operation: "motion_control",
      tool: "generate_kie_kling_3_0_motion_control",
      model: "kling-3.0/motion-control",
    }));
    expect(motion?.inputs).toEqual(expect.objectContaining({
      generationSettings: {
        mode: "720p",
        character_orientation: "video",
        background_source: "input_image",
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
        targetInput: "video",
      }),
      expect.objectContaining({
        source: frame?.id,
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
      edge.source === extract?.id && edge.target === kittens?.id)).toBe(false);
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
    const args = modelArgs(
      generateKling30MotionControlVideoDef(engine),
      seeded,
      motion,
      engine.book.get().bookId,
      engine,
    );
    expect(args).toEqual(expect.objectContaining({
      mode: "720p",
      character_orientation: "video",
      background_source: "input_image",
      character_image_refs: [`@${kittenOutput?.outputArtifactId}`],
      motion_video_refs: [`@${source.outputArtifactId}`],
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
