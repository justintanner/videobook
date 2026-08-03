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

async function makeLowRateMp4(path: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=12:d=1.2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    path,
  ]);
}

async function makeAudioOnlyMp4(path: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:a",
    "aac",
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

  it("captures the last frame when container duration rounds past video duration", async () => {
    if (!engine || !rootDir) throw new Error("engine missing");
    const sourcePath = join(rootDir, "low-rate.mp4");
    await makeLowRateMp4(sourcePath);
    const source = await engine.artifacts.create({
      kind: "video",
      name: "low-rate clip",
    });
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
      { startSeconds: 0.1, endSeconds: 0.9 },
      "low-rate split",
    );
    const last = await captureFrame(engine, split.artifactId, {
      role: "last",
      title: "low-rate last frame",
    });
    const manifest = await engine.files.manifest(last.artifactId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.files.some((file) =>
      file.name.endsWith(".jpg"))).toBe(true);
  }, 60_000);

  it("rejects split ranges that start at the end of the source video", async () => {
    if (!engine || !rootDir) throw new Error("engine missing");
    const sourcePath = join(rootDir, "short-source.mp4");
    await makeSourceMp4(sourcePath, 2);
    const source = await engine.artifacts.create({
      kind: "video",
      name: "short source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const ingested = await engine.files.writeFromPath(
      source.value.artifactId,
      "original.mp4",
      sourcePath,
    );
    expect(ingested.ok).toBe(true);

    await expect(splitSourceRange(
      engine,
      source.value.artifactId,
      { startSeconds: 2, endSeconds: 3 },
      "out-of-range split",
    )).rejects.toThrow(/starts at or after the source video duration/);
  }, 60_000);

  it("rejects video operations on an audio-only media artifact", async () => {
    if (!engine || !rootDir) throw new Error("engine missing");
    const sourcePath = join(rootDir, "audio-only.mp4");
    await makeAudioOnlyMp4(sourcePath);
    const source = await engine.artifacts.create({
      kind: "video",
      name: "audio-only source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const ingested = await engine.files.writeFromPath(
      source.value.artifactId,
      "original.mp4",
      sourcePath,
    );
    expect(ingested.ok).toBe(true);

    await expect(splitSourceRange(
      engine,
      source.value.artifactId,
      { startSeconds: 0, endSeconds: 1 },
      "audio-only split",
    )).rejects.toThrow(/source has no video stream/);
    await expect(captureFrame(engine, source.value.artifactId, {
      role: "first",
      title: "audio-only frame",
    })).rejects.toThrow(/source has no video stream/);
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
      type: "video",
      slug: "vid-source",
      slot: { row: 0, column: 0 },
      outputArtifactId: sourceArtifact.value.artifactId,
      inputs: { workflowRole: "source" },
    });
    const analysis = engine.notebooks.createCell({
      type: "analyze",
      slug: "analyze-source",
      slot: { row: 1, column: 0 },
      prompt: "Segment",
      provider: "kie",
      model: "gemini-3.5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
      inputs: { workflowRole: "analysis" },
    });
    const analysisOutput = engine.notebooks.createCell({
      type: "analysis",
      slug: "analysis-source",
      slot: { row: 2, column: 0 },
      inputs: {
        workflowRole: "analysis-output",
        analysisRole: "result",
        producerCellId: analysis.id,
      },
    });
    const sourceEdge = engine.notebooks.createEdge({
      source: source.id,
      target: analysis.id,
      targetInput: "source",
    });
    const resultEdge = engine.notebooks.createEdge({
      source: analysis.id,
      target: analysisOutput.id,
      targetInput: "result",
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [source, analysis, analysisOutput],
      edges: [sourceEdge, resultEdge],
    });
    expect(written.ok).toBe(true);

    const first = await applyAnalysisResults(engine, {
      ...notebook.value,
      cells: [source, analysis, analysisOutput],
      edges: [sourceEdge, resultEdge],
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
      materializeWorkflow: true,
    });
    expect(first.cells.filter((cell) => cell.operation === "split_range")).toHaveLength(2);
    expect(first.cells.find((cell) => cell.id === analysis.id)).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      tool: "openai_responses_analysis",
    });
    expect(first.cells.filter((cell) => cell.operation === "rewrite_prompt")
      .every((cell) => cell.model === "gpt-5.6-sol")).toBe(true);
    const firstAnalysisOutput = first.cells.find((cell) =>
      cell.id === analysisOutput.id);
    expect(firstAnalysisOutput?.outputArtifactId).toBeTruthy();
    expect(firstAnalysisOutput?.inputs?.outputVersionArtifactIds).toEqual([
      firstAnalysisOutput?.outputArtifactId,
    ]);
    const firstAnalysisMetadata = await engine.metadata.artifacts.read<{
      analysisInfo?: {
        sourceDurationSeconds?: number;
        shots?: Array<{ ordinal: number }>;
      };
    }>(firstAnalysisOutput!.outputArtifactId!, "original");
    expect(firstAnalysisMetadata.ok).toBe(true);
    if (firstAnalysisMetadata.ok) {
      expect(firstAnalysisMetadata.value.analysisInfo).toMatchObject({
        sourceDurationSeconds: 16,
        shots: [{ ordinal: 1 }, { ordinal: 2 }],
      });
    }
    expect(first.cells.filter((cell) => cell.operation === "extract_audio")).toHaveLength(2);
    const firstVideos = first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-video-"));
    expect(firstVideos).toHaveLength(2);
    expect(firstVideos.every((cell) => cell.type === "video")).toBe(true);
    const frameCells = first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("frame-"));
    expect(frameCells).toHaveLength(4);
    expect(frameCells.every((cell) =>
      cell.type === "image"
      && cell.operation === undefined
      && cell.tool === undefined)).toBe(true);
    expect(first.cells.filter((cell) => cell.operation === "image_to_video")).toHaveLength(2);
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const split = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `split-video-${ordinal}`);
      const video = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-video-${ordinal}`);
      const extractAudio = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-extract-audio-${ordinal}`);
      const audio = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-audio-${ordinal}`);
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: analysisOutput.id,
        target: split?.id,
        targetInput: "analysis",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: split?.id,
        target: video?.id,
        targetInput: "media",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: video?.id,
        target: extractAudio?.id,
        targetInput: "video",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: extractAudio?.id,
        target: audio?.id,
        targetInput: "media",
      }));
      expect(video?.operation).toBeUndefined();
      expect(audio?.operation).toBeUndefined();
    }
    const order = topologicalOrder(first);
    expect(order.map((cell) => cell.id)).toContain(analysis.id);

    const persistedOnly = await applyAnalysisResults(
      engine,
      first,
      analysis.id,
      {
        rawOutput: {
          scenes: [
            { title: "one-a", timestamp: [0, 4] },
            { title: "one-b", timestamp: [4, 8] },
            { title: "two", timestamp: [8, 16] },
          ],
        },
        sourceDurationSeconds: 16,
        request: { mode: "fixture" },
        sourceArtifactId: sourceArtifact.value.artifactId,
      },
    );
    expect(persistedOnly.cells.map((cell) => cell.id).sort())
      .toEqual(first.cells.map((cell) => cell.id).sort());
    expect(persistedOnly.edges).toEqual(first.edges);
    expect(persistedOnly.cells.filter((cell) =>
      cell.operation === "split_range")).toHaveLength(2);
    expect(persistedOnly.cells.find((cell) =>
      cell.id === analysisOutput.id)?.inputs?.shotCount).toBe(3);

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
      materializeWorkflow: true,
    });
    expect(second.cells.filter((cell) => cell.operation === "split_range").map((cell) => cell.id).sort())
      .toEqual(first.cells.filter((cell) => cell.operation === "split_range").map((cell) => cell.id).sort());
    const secondAnalysisOutput = second.cells.find((cell) =>
      cell.id === analysisOutput.id);
    expect(secondAnalysisOutput?.outputArtifactId)
      .not.toBe(firstAnalysisOutput?.outputArtifactId);
    expect(secondAnalysisOutput?.inputs?.outputVersionArtifactIds).toEqual([
      firstAnalysisOutput?.outputArtifactId,
      secondAnalysisOutput?.outputArtifactId,
    ]);
    expect(second.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-video-"))
      .map((cell) => cell.id)
      .sort())
      .toEqual(firstVideos.map((cell) => cell.id).sort());

    const assembly = engine.notebooks.createCell({
      type: "concat",
      slug: "concat-scenes",
      slot: { row: 11, column: 0 },
      operation: "concat_video",
      tool: "ffmpeg",
      inputs: { workflowRole: "assembly" },
    });
    const manual = engine.notebooks.createCell({
      type: "prompt",
      slug: "prompt-manual-note",
      slot: { row: 12, column: 0 },
      prompt: "Keep this card in place",
    });
    const staged = {
      ...second,
      cells: [...second.cells, assembly, manual],
    };
    const stagedWritten = await engine.notebooks.write(staged);
    expect(stagedWritten.ok).toBe(true);
    const retainedSplit = staged.cells.find((cell) =>
      cell.inputs?.workflowRole === "split-video-2");
    expect(retainedSplit).toBeTruthy();
    if (!retainedSplit) return;
    const retainedBranch = staged.cells.filter((cell) =>
      cell.id === retainedSplit.id
      || cell.inputs?.splitVideoCellId === retainedSplit.id);
    expect(retainedBranch).toHaveLength(8);

    const changed = await applyAnalysisResults(engine, staged, analysis.id, {
      rawOutput: {
        scenes: [
          { title: "one-a", timestamp: [0, 4] },
          { title: "one-b", timestamp: [4, 8] },
          { title: "two", timestamp: [8, 16] },
        ],
      },
      sourceDurationSeconds: 16,
      request: { mode: "fixture" },
      sourceArtifactId: sourceArtifact.value.artifactId,
      materializeWorkflow: true,
    });
    expect(changed.cells.filter((cell) => cell.operation === "split_range")).toHaveLength(3);
    expect(changed.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-video-"))).toHaveLength(3);
    for (const retained of retainedBranch) {
      const reconciled = changed.cells.find((cell) => cell.id === retained.id);
      expect(reconciled?.slot).toEqual(retained.slot);
      expect(reconciled?.slug).toBe(retained.slug);
      expect(reconciled?.inputs?.ordinal).toBe(3);
    }
    const newSplit = changed.cells.find((cell) =>
      cell.inputs?.workflowRole === "split-video-2");
    expect(newSplit).toBeTruthy();
    if (!newSplit) return;
    expect(newSplit.id).not.toBe(retainedSplit.id);
    const newBranch = changed.cells.filter((cell) =>
      cell.id === newSplit.id
      || cell.inputs?.splitVideoCellId === newSplit.id);
    expect(newBranch).toHaveLength(8);
    const stagedIds = new Set(staged.cells.map((cell) => cell.id));
    expect(newBranch.every((cell) => !stagedIds.has(cell.id))).toBe(true);
    expect(newBranch.every((cell) =>
      cell.slot.row >= 0
      && cell.slot.row < 26
      && cell.slot.column >= 0
      && cell.slot.column < 13)).toBe(true);
    expect(new Set(changed.cells.map((cell) =>
      `${cell.slot.row}:${cell.slot.column}`)).size).toBe(changed.cells.length);
    expect(new Set(changed.cells.map((cell) => cell.slug)).size)
      .toBe(changed.cells.length);
    expect(newBranch.every((cell) =>
      cell.slot.row !== assembly.slot.row
      || cell.slot.column !== assembly.slot.column)).toBe(true);
    expect(newBranch.every((cell) =>
      cell.slot.row !== manual.slot.row
      || cell.slot.column !== manual.slot.column)).toBe(true);

    const removedArtifact = await engine.artifacts.create({
      kind: "video",
      name: "removed branch output",
    });
    expect(removedArtifact.ok).toBe(true);
    if (!removedArtifact.ok) return;
    const changedWithOutput = {
      ...changed,
      cells: changed.cells.map((cell) =>
        cell.id === newSplit.id
          ? { ...cell, outputArtifactId: removedArtifact.value.artifactId }
          : cell),
    };
    const changedWritten = await engine.notebooks.write(changedWithOutput);
    expect(
      changedWritten.ok,
      changedWritten.ok ? undefined : changedWritten.error.message,
    ).toBe(true);

    const shrunk = await applyAnalysisResults(
      engine,
      changedWithOutput,
      analysis.id,
      {
        rawOutput: {
          scenes: [
            { title: "one", timestamp: [0, 8] },
            { title: "two", timestamp: [8, 16] },
          ],
        },
        sourceDurationSeconds: 16,
        request: { mode: "fixture" },
        sourceArtifactId: sourceArtifact.value.artifactId,
        materializeWorkflow: true,
      },
    );
    const removedIds = new Set(newBranch.map((cell) => cell.id));
    expect(shrunk.cells.every((cell) => !removedIds.has(cell.id))).toBe(true);
    expect(shrunk.cells.find((cell) => cell.id === assembly.id)?.slot)
      .toEqual(assembly.slot);
    expect(shrunk.cells.find((cell) => cell.id === manual.id)?.slot)
      .toEqual(manual.slot);
    expect(engine.artifacts.list().some((artifact) =>
      artifact.artifactId === removedArtifact.value.artifactId)).toBe(true);
    const shrunkWritten = await engine.notebooks.write(shrunk);
    expect(shrunkWritten.ok).toBe(true);
  });

  it("requires exactly one paired Analysis result", async () => {
    if (!engine) throw new Error("engine missing");
    const notebook = await engine.notebooks.create("Analysis invariant");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const analyze = engine.notebooks.createCell({
      type: "analyze",
      slug: "analyze-invariant",
      slot: { row: 0, column: 0 },
    });
    const run = (document: typeof notebook.value) =>
      applyAnalysisResults(engine!, document, analyze.id, {
        rawOutput: {
          scenes: [{ title: "one", timestamp: [0, 8] }],
        },
        sourceDurationSeconds: 8,
        request: { mode: "fixture" },
        sourceArtifactId: "",
      });
    await expect(run({
      ...notebook.value,
      cells: [analyze],
      edges: [],
    })).rejects.toThrow(/exactly one connected Analysis result cell/);

    const first = engine.notebooks.createCell({
      type: "analysis",
      slug: "analysis-invariant-one",
      slot: { row: 1, column: 0 },
      inputs: {
        analysisRole: "result",
        producerCellId: analyze.id,
      },
    });
    const second = engine.notebooks.createCell({
      type: "analysis",
      slug: "analysis-invariant-two",
      slot: { row: 2, column: 0 },
      inputs: {
        analysisRole: "result",
        producerCellId: analyze.id,
      },
    });
    await expect(run({
      ...notebook.value,
      cells: [analyze, first, second],
      edges: [first, second].map((cell) =>
        engine!.notebooks.createEdge({
          source: analyze.id,
          target: cell.id,
          targetInput: "result",
        })),
    })).rejects.toThrow(/exactly one connected Analysis result cell/);
  });
});
