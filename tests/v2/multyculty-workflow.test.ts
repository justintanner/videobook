import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  type Engine,
} from "videobook-engine";
import { FFMPEG } from "../../server/src/ffmpeg.js";
import {
  seedMultycultyWorkflow,
} from "../../server/src/multyculty-workflow.js";

const execFileAsync = promisify(execFile);

describe("Multyculty workflow fixture", () => {
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

  it("builds an idempotent compact video-to-concat graph", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-multyculty-"));
    engine = createEngine({ rootDir, initialBookSlug: "multyculty" });
    await engine.ready;
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);

    const artifactSpecs = [
      ["video", "vid-source-selection"],
      ["video", "vid-section-intro"],
      ["video", "vid-section-culture"],
      ["video", "vid-animated-intro"],
      ["video", "vid-animated-culture"],
      ["final", "final"],
    ] as const;
    const artifacts = new Map<string, string>();
    for (const [kind, slug] of artifactSpecs) {
      const artifact = await engine.artifacts.create(kind, slug);
      expect(artifact.ok).toBe(true);
      if (artifact.ok) artifacts.set(slug, artifact.value.artifactId);
    }
    const sourceId = artifacts.get("vid-source-selection");
    expect(sourceId).toBeTruthy();
    if (!sourceId) return;
    mediaDir = await mkdtemp(join(tmpdir(), "videobook-multyculty-media-"));
    const sourcePath = join(mediaDir, "source.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=c=0x10261b:s=160x90:r=6:d=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      sourcePath,
    ]);
    const file = await engine.files.writeFromPath(
      sourceId,
      "original.mp4",
      sourcePath,
    );
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    for (const slug of ["vid-animated-intro", "vid-animated-culture"]) {
      const artifactId = artifacts.get(slug);
      expect(artifactId).toBeTruthy();
      if (!artifactId) return;
      const animationFile = await engine.files.writeFromPath(
        artifactId,
        "original.mp4",
        sourcePath,
      );
      expect(animationFile.ok).toBe(true);
    }
    const manifest = await engine.files.manifest(sourceId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const objectHash = manifest.value.files[0]?.objectHash;
    expect(objectHash).toBeTruthy();
    if (!objectHash) return;
    const stream = await engine.streams.register({
      artifactId: sourceId,
      sourcePath: "original.mp4",
      objectHash,
      streamIndex: 1,
      kind: "audio",
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 1_440_000,
      codec: "aac",
      audio: {
        sampleRateHz: 48_000,
        channels: 2,
        channelLayout: "stereo",
      },
    });
    expect(stream.ok).toBe(true);

    const seeded = await seedMultycultyWorkflow(engine);
    const interrupted = await engine.notebooks.write({
      ...seeded,
      cells: seeded.cells.map((cell) =>
        cell.inputs?.workflowRole?.toString().startsWith("animate-")
          ? {
              ...cell,
              outputArtifactId: undefined,
              inputs: {
                ...(cell.inputs ?? {}),
                state: "pending",
              },
            }
          : cell),
    });
    expect(interrupted.ok).toBe(true);
    const first = await seedMultycultyWorkflow(engine, {
      materializeLocalOutputs: true,
    });
    expect(new Set(first.cells.map((cell) => cell.type))).toEqual(new Set([
      "video",
      "analyze",
      "extract_audio",
      "audio",
      "split_video",
      "image",
      "prompt",
      "generate_video",
      "concat",
    ]));
    expect(first.properties?.stageLabels).toBeUndefined();
    expect(first.properties?.featureLanes).toBeUndefined();
    const source = first.cells.find((cell) => cell.inputs?.workflowRole === "source");
    const analysis = first.cells.find((cell) => cell.inputs?.workflowRole === "analysis");
    const sourceExtractAudio = first.cells.find((cell) =>
      cell.inputs?.workflowRole === "source-extract-audio");
    const audio = first.cells.find((cell) => cell.inputs?.workflowRole === "source-audio");
    const assembly = first.cells.find((cell) => cell.inputs?.workflowRole === "assembly");
    expect(source).toBeTruthy();
    expect(analysis).toBeTruthy();
    expect(sourceExtractAudio).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(assembly).toBeTruthy();
    expect(first.cells).toHaveLength(21);
    expect(first.edges).toHaveLength(36);
    expect(first.cells.filter((cell) => cell.operation === "split_range")).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.operation === "extract_audio")).toHaveLength(3);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-video-"))).toHaveLength(2);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("frame-"))).toHaveLength(4);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("frame-")).every((cell) =>
      cell.operation === undefined && cell.tool === undefined)).toBe(true);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-audio-"))).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.operation === "rewrite_prompt")).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.operation === "image_to_video")).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.operation === "concat_video")).toHaveLength(1);
    expect(first.cells.every((cell) => cell.outputArtifactId)).toBe(true);
    expect(first.properties?.multycultyFixture).toEqual(expect.objectContaining({
      materializedAt: expect.any(String),
      noPaidCalls: true,
    }));
    expect(source?.slot).toEqual({ row: 0, column: 0 });
    expect(sourceExtractAudio?.slot).toEqual({ row: 0, column: 1 });
    expect(analysis?.slot).toEqual({ row: 1, column: 0 });
    expect(analysis?.prompt).toContain("two continuous 15-second");
    expect(audio?.slot).toEqual({ row: 1, column: 1 });
    const featureColumns = [-2, 2];
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const column = featureColumns[ordinal - 1];
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `split-video-${ordinal}`)?.slot)
        .toEqual({ row: 2, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-video-${ordinal}`)?.slot)
        .toEqual({ row: 3, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `frame-first-${ordinal}`)?.slot)
        .toEqual({ row: 4, column: column - 1 });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `frame-last-${ordinal}`)?.slot)
        .toEqual({ row: 4, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-extract-audio-${ordinal}`)?.slot)
        .toEqual({ row: 4, column: column + 1 });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-audio-${ordinal}`)?.slot)
        .toEqual({ row: 5, column: column + 1 });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `prompt-${ordinal}`)?.slot)
        .toEqual({ row: 5, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `animate-${ordinal}`)?.slot)
        .toEqual({ row: 6, column });
    }
    expect(assembly?.slot).toEqual({ row: 7, column: 0 });
    expect(assembly?.title).toBe("@concat · scenes");
    expect(first.cells.filter((cell) => cell.operation === "rewrite_prompt").every((cell) =>
      cell.inputs?.requiresConfirmation === true)).toBe(true);
    expect(first.cells.filter((cell) => cell.operation === "image_to_video").every((cell) =>
      cell.inputs?.requiresConfirmation === true
      && cell.inputs?.fixtureBaseline === true)).toBe(true);
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: source?.id,
      target: analysis?.id,
      targetInput: "source",
    }));
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: source?.id,
      target: sourceExtractAudio?.id,
      targetInput: "video",
    }));
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: sourceExtractAudio?.id,
      target: audio?.id,
      targetInput: "media",
    }));
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const split = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `split-video-${ordinal}`);
      const video = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-video-${ordinal}`);
      const extractAudio = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-extract-audio-${ordinal}`);
      const sceneAudio = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-audio-${ordinal}`);
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: source?.id,
        target: split?.id,
        targetInput: "video",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: analysis?.id,
        target: split?.id,
        targetInput: "analysis",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: split?.id,
        target: video?.id,
        targetInput: "media",
      }));
      expect(video?.type).toBe("video");
      expect(video?.outputArtifactId).toBe(split?.outputArtifactId);
      for (const role of [
        `frame-first-${ordinal}`,
        `frame-last-${ordinal}`,
      ]) {
        const extracted = first.cells.find((cell) =>
          cell.inputs?.workflowRole === role);
        expect(first.edges).toContainEqual(expect.objectContaining({
          source: video?.id,
          target: extracted?.id,
          targetInput: "segment",
        }));
      }
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: video?.id,
        target: extractAudio?.id,
        targetInput: "video",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: extractAudio?.id,
        target: sceneAudio?.id,
        targetInput: "media",
      }));
      expect(sceneAudio?.type).toBe("audio");
      expect(sceneAudio?.outputArtifactId).toBe(extractAudio?.outputArtifactId);
      const prompt = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `prompt-${ordinal}`);
      const animation = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `animate-${ordinal}`);
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: prompt?.id,
        target: animation?.id,
        targetInput: "prompt",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: animation?.id,
        target: assembly?.id,
        targetInput: `clip:${ordinal - 1}`,
      }));
    }
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: audio?.id,
      target: assembly?.id,
      targetInput: "audio",
    }));
    const downgraded = await engine.notebooks.write({
      ...first,
      properties: {
        ...(first.properties ?? {}),
        multycultyFixture: { version: 0 },
      },
    });
    expect(downgraded.ok).toBe(true);
    const second = await seedMultycultyWorkflow(engine);
    expect(second.cells).toHaveLength(21);
    expect(second.edges).toHaveLength(36);
    expect(second.cells.filter((cell) => cell.operation === "split_range")).toHaveLength(2);
    expect(second.cells.find((cell) => cell.inputs?.workflowRole === "source")?.id)
      .not.toBe(source?.id);
  }, 90_000);
});
