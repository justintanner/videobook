import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { FFMPEG } from "../../server/src/ffmpeg.js";
import {
  captureFrame,
  extractSourceAudio,
  splitSourceRange,
} from "../../server/src/notebook-media-ops.js";
import { applyAnalysisResults } from "../../server/src/notebook-workflow.js";
import { topologicalOrder } from "../../server/src/jobs/run-notebook.js";

const execFileAsync = promisify(execFile);

async function makeSourceMp4(path: string, durationSeconds = 6): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=320x240:rate=30:duration=${durationSeconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${durationSeconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    path,
  ]);
}

describe("notebook local media and analysis fan-out", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-media-dag-"));
    engine = createEngine({ rootDir, initialBookSlug: "media-dag" });
    await engine.ready;
  });

  it("produces split duration, first/last frames, and playable audio on real FFmpeg media", async () => {
    if (!engine || !rootDir) throw new Error("engine missing");
    const sourcePath = join(rootDir, "source.mp4");
    await makeSourceMp4(sourcePath, 6);
    const source = await engine.artifacts.create({ kind: "video", name: "source clip" });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const ingested = await engine.files.writeFromPath(
      source.value.artifactId,
      "original.mp4",
      sourcePath,
    );
    expect(ingested.ok).toBe(true);

    const split = await splitSourceRange(
      engine,
      source.value.artifactId,
      { startSeconds: 1, endSeconds: 4 },
      "shot-01",
    );
    expect(split.durationSeconds).toBeGreaterThan(2.5);
    expect(split.durationSeconds).toBeLessThan(3.5);

    const first = await captureFrame(engine, split.artifactId, {
      role: "first",
      title: "first frame",
    });
    const last = await captureFrame(engine, split.artifactId, {
      role: "last",
      title: "last frame",
    });
    expect(first.artifactId).not.toBe(last.artifactId);
    const firstManifest = await engine.files.manifest(first.artifactId);
    const lastManifest = await engine.files.manifest(last.artifactId);
    expect(firstManifest.ok && firstManifest.value.files.some((file) => file.name.endsWith(".jpg"))).toBe(true);
    expect(lastManifest.ok && lastManifest.value.files.some((file) => file.name.endsWith(".jpg"))).toBe(true);

    const audio = await extractSourceAudio(engine, source.value.artifactId, "source audio");
    const audioManifest = await engine.files.manifest(audio.artifactId);
    expect(audioManifest.ok).toBe(true);
    if (!audioManifest.ok) return;
    expect(audioManifest.value.files.some((file) => file.name.endsWith(".m4a"))).toBe(true);
    expect(audio.durationSeconds).toBeGreaterThan(5);
  }, 60_000);

  it("fans out owned split/frame/video branches from fixture analysis without deleting artifacts", async () => {
    if (!engine) throw new Error("engine missing");
    const notebook = await engine.notebooks.create("Workflow");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const sourceArtifact = await engine.artifacts.create({ kind: "video", name: "source" });
    expect(sourceArtifact.ok).toBe(true);
    if (!sourceArtifact.ok) return;
    await engine.files.write(sourceArtifact.value.artifactId, "original.mp4", Buffer.from("fixture"));

    const source = engine.notebooks.createCell({
      type: "source",
      title: "source",
      slot: { row: 0, column: 0 },
      outputArtifactId: sourceArtifact.value.artifactId,
      inputs: { workflowRole: "source" },
    });
    const analysis = engine.notebooks.createCell({
      type: "note",
      title: "analyze",
      slot: { row: 1, column: 0 },
      prompt: "Segment",
      provider: "kie",
      model: "gemini-3.5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
      inputs: { workflowRole: "analysis" },
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [source, analysis],
      edges: [
        engine.notebooks.createEdge({
          source: source.id,
          target: analysis.id,
          targetInput: "source",
        }),
      ],
    });
    expect(written.ok).toBe(true);

    const first = await applyAnalysisResults(engine, {
      ...notebook.value,
      cells: [source, analysis],
      edges: [
        engine.notebooks.createEdge({
          source: source.id,
          target: analysis.id,
          targetInput: "source",
        }),
      ],
    }, analysis.id, {
      rawOutput: {
        scenes: [
          { title: "one", timestamp: [0, 8] },
          { title: "two", timestamp: [8, 16] },
        ],
      },
      sourceDurationSeconds: 16,
      request: { mode: "fixture" },
      sourceArtifactId: sourceArtifact.value.artifactId,
    });
    expect(first.cells.filter((cell) => cell.operation === "split_range")).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.operation === "capture_frame")).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.operation === "image_to_video")).toHaveLength(2);
    const order = topologicalOrder(first);
    expect(order.map((cell) => cell.id)).toContain(analysis.id);

    const second = await applyAnalysisResults(engine, first, analysis.id, {
      rawOutput: {
        scenes: [
          { title: "one", timestamp: [0, 8] },
          { title: "two", timestamp: [8, 16] },
        ],
      },
      sourceDurationSeconds: 16,
      request: { mode: "fixture" },
      sourceArtifactId: sourceArtifact.value.artifactId,
    });
    expect(second.cells.filter((cell) => cell.operation === "split_range").map((cell) => cell.id).sort())
      .toEqual(first.cells.filter((cell) => cell.operation === "split_range").map((cell) => cell.id).sort());

    const grown = await applyAnalysisResults(engine, second, analysis.id, {
      rawOutput: {
        scenes: [
          { title: "one", timestamp: [0, 8] },
          { title: "two", timestamp: [8, 16] },
          { title: "three", timestamp: [16, 24] },
        ],
      },
      sourceDurationSeconds: 24,
      request: { mode: "fixture" },
      sourceArtifactId: sourceArtifact.value.artifactId,
    });
    expect(grown.cells.filter((cell) => cell.operation === "split_range")).toHaveLength(3);
    // Artifacts from the prior analysis script remain in the catalog.
    expect(engine.artifacts.list().length).toBeGreaterThanOrEqual(2);
  });
});
