import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { FFMPEG } from "../../server/src/ffmpeg.js";
import { seedMultycultyWorkflow } from "../../server/src/multyculty-workflow.js";

const execFileAsync = promisify(execFile);

describe("Multyculty workflow fixture", () => {
  let rootDir: string | undefined;
  let mediaDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
  });

  it("builds an idempotent compact source-to-media graph", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-multyculty-"));
    engine = createEngine({ rootDir, initialBookSlug: "multyculty" });
    await engine.ready;
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);

    const artifactSpecs = [
      ["video", "vid-source-selection"],
      ["video", "vid-section-intro"],
      ["video", "vid-section-culture"],
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

    const first = await seedMultycultyWorkflow(engine, {
      materializeLocalOutputs: true,
    });
    expect(first.cells.filter((cell) => cell.type === "label")).toEqual([]);
    expect(first.properties?.stageLabels).toBeUndefined();
    expect(first.properties?.featureLanes).toBeUndefined();
    const source = first.cells.find((cell) => cell.inputs?.workflowRole === "source");
    const analysis = first.cells.find((cell) => cell.inputs?.workflowRole === "analysis");
    const audio = first.cells.find((cell) => cell.inputs?.workflowRole === "source-audio");
    expect(source).toBeTruthy();
    expect(analysis).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(first.cells).toHaveLength(11);
    expect(first.edges).toHaveLength(12);
    expect(first.cells.filter((cell) => cell.type === "split")).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.type === "frame")).toHaveLength(4);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-audio-"))).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.type === "prompt")).toEqual([]);
    expect(first.cells.filter((cell) => cell.type === "video")).toEqual([]);
    expect(first.cells.filter((cell) => cell.type === "sequence")).toEqual([]);
    expect(first.cells.filter((cell) => cell.type === "export")).toEqual([]);
    expect(first.cells.every((cell) => cell.outputArtifactId)).toBe(true);
    expect(first.properties?.multycultyFixture).toEqual(expect.objectContaining({
      materializedAt: expect.any(String),
    }));
    expect(source?.slot).toEqual({ row: 0, column: 0 });
    expect(analysis?.slot).toEqual({ row: 1, column: 0 });
    expect(analysis?.prompt).toContain("two continuous 15-second");
    expect(audio?.slot).toEqual({ row: 0, column: 1 });
    const featureColumns = [-2, 2];
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const column = featureColumns[ordinal - 1];
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `split-${ordinal}`)?.slot)
        .toEqual({ row: 2, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `frame-first-${ordinal}`)?.slot)
        .toEqual({ row: 3, column: column - 1 });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `frame-last-${ordinal}`)?.slot)
        .toEqual({ row: 3, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-audio-${ordinal}`)?.slot)
        .toEqual({ row: 3, column: column + 1 });
    }
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: source?.id,
      target: analysis?.id,
      targetInput: "source",
    }));
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: source?.id,
      target: audio?.id,
      targetInput: "source",
    }));
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const split = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `split-${ordinal}`);
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: source?.id,
        target: split?.id,
        targetInput: "source",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: analysis?.id,
        target: split?.id,
        targetInput: "analysis",
      }));
    }

    const downgraded = await engine.notebooks.write({
      ...first,
      properties: {
        ...(first.properties ?? {}),
        multycultyFixture: { version: 0 },
      },
    });
    expect(downgraded.ok).toBe(true);
    const second = await seedMultycultyWorkflow(engine);
    expect(second.cells).toHaveLength(11);
    expect(second.edges).toHaveLength(12);
    expect(second.cells.filter((cell) => cell.type === "split")).toHaveLength(2);
    // Source identity is preserved across rematerialization.
    expect(second.cells.find((cell) => cell.inputs?.workflowRole === "source")?.id)
      .toBe(source?.id);
  }, 90_000);
});
