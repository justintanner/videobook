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
  MULTYCULTY_FIXTURE_VERSION,
  seedMultycultyWorkflow,
} from "../../server/src/multyculty-workflow.js";
import { applyAnalysisResults } from "../../server/src/notebook-workflow.js";

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
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "multyculty" });
    await engine.ready;
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);

    const artifactSpecs = [
      ["video", "Source selection"],
      ["video", "Intro section video"],
      ["video", "Culture section video"],
      ["video", "Intro animated video"],
      ["video", "Culture animated video"],
      ["final", "Final"],
    ] as const;
    const artifacts = new Map<string, string>();
    for (const [kind, label] of artifactSpecs) {
      const artifact = await engine.artifacts.create(kind, label);
      expect(artifact.ok).toBe(true);
      if (artifact.ok) artifacts.set(label, artifact.value.artifactId);
    }
    const sourceId = artifacts.get("Source selection");
    expect(sourceId).toBeTruthy();
    if (!sourceId) return;
    mediaDir = await mkdtemp(join(tmpdir(), "videobook-multyculty-media-"));
    const sourcePath = join(mediaDir, "source.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=c=0x10261b:s=160x90:r=6:d=15",
      "-f", "lavfi", "-i", "color=c=0x274b3a:s=160x90:r=6:d=15",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[video]",
      "-map", "[video]",
      "-map", "2:a",
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
    for (const label of ["Intro animated video", "Culture animated video"]) {
      const artifactId = artifacts.get(label);
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

    expect(engine.files.listSubdir(sourceId, "original_frames"))
      .toEqual({ ok: true, value: [] });
    const seeded = await seedMultycultyWorkflow(engine);
    const sourceFrames = engine.files.listSubdir(sourceId, "original_frames");
    expect(sourceFrames.ok).toBe(true);
    if (!sourceFrames.ok) return;
    expect(sourceFrames.value.length).toBeGreaterThan(1);
    expect(sourceFrames.value.every((name) =>
      /^\d+\.\d{2}\.jpg$/.test(name))).toBe(true);
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
      "analysis",
      "audio",
      "split_video",
      "image",
      "prompt",
      "generate_video",
      "concat",
    ]));
    expect(first).not.toHaveProperty("properties");
    const source = first.cells.find((cell) => cell.inputs?.workflowRole === "source");
    const analysis = first.cells.find((cell) => cell.inputs?.workflowRole === "analysis");
    const analysisOutput = first.cells.find((cell) =>
      cell.inputs?.workflowRole === "analysis-output");
    const sourceExtractAudio = first.cells.find((cell) =>
      cell.inputs?.workflowRole === "source-extract-audio");
    const assembly = first.cells.find((cell) => cell.inputs?.workflowRole === "assembly");
    expect(source).toBeTruthy();
    expect(analysis).toBeTruthy();
    expect(analysisOutput).toBeTruthy();
    expect(sourceExtractAudio).toBeTruthy();
    expect(assembly).toBeTruthy();
    expect(first.cells).toHaveLength(19);
    expect(first.edges).toHaveLength(34);
    expect(first.cells.filter((cell) => cell.operation === "split_range")).toHaveLength(2);
    expect(first.cells.filter((cell) =>
      cell.inputs?.mediaRole === "extract-audio-output"
      || cell.operation === "extract_audio")).toHaveLength(3);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-video-"))).toHaveLength(2);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("frame-"))).toHaveLength(4);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("frame-")).every((cell) =>
      cell.operation === undefined && cell.tool === undefined)).toBe(true);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-audio-"))).toHaveLength(0);
    expect(first.cells.filter((cell) => cell.operation === "rewrite_prompt")).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.operation === "image_to_video")).toHaveLength(2);
    expect(first.cells.filter((cell) => cell.operation === "concat_video")).toHaveLength(1);
    expect(first.cells.every((cell) => cell.outputArtifactId)).toBe(true);
    expect(first.fixture).toEqual(expect.objectContaining({
      version: MULTYCULTY_FIXTURE_VERSION,
      materializedAt: expect.any(String),
      noPaidCalls: true,
    }));
    expect(source?.outputArtifactId).toBe(sourceId);
    expect(source?.slot).toEqual({ row: 0, column: 3 });
    expect(analysis?.slot).toEqual({ row: 1, column: 2 });
    expect(sourceExtractAudio?.slot).toEqual({ row: 1, column: 4 });
    expect(analysisOutput?.slot).toEqual({ row: 2, column: 2 });
    expect(analysis?.prompt).toContain("verified camera switches");
    expect(analysis?.inputs?.fixtureOwner).toBe("multyculty-default");
    expect(analysis?.inputs).not.toHaveProperty("fixtureAnalysis");
    expect(analysis?.inputs).not.toHaveProperty("analysisFixture");
    expect(analysis?.outputArtifactId).toBeTruthy();
    if (!analysis?.outputArtifactId) return;
    const analysisArtifact = await engine.files.read(
      analysis.outputArtifactId,
      "analysis.json",
    );
    expect(analysisArtifact.ok).toBe(true);
    if (!analysisArtifact.ok) return;
    const savedAnalysis = JSON.parse(analysisArtifact.value.toString()) as {
      version: number;
      request: Record<string, unknown>;
      llmExchanges: Array<{
        provider: string;
        model: string;
        stage: string;
        input: Record<string, unknown>;
        response: Record<string, unknown>;
      }>;
      evidence: {
        visualCandidates: unknown[];
        visualDecisions: unknown[];
      };
      boundaries: Array<Record<string, unknown>>;
    };
    expect(savedAnalysis).toMatchObject({
      version: 3,
      request: {
        mode: "multyculty-fixture",
        provider: "openai",
        model: "gpt-5.6-sol",
        pipelineVersion: 3,
      },
      evidence: {
        visualCandidates: [expect.objectContaining({
          id: "visual-001",
          timestampSeconds: 15,
        })],
        visualDecisions: [expect.objectContaining({
          candidateId: "visual-001",
          cameraSwitch: true,
          accepted: true,
        })],
      },
    });
    expect(savedAnalysis.llmExchanges).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-sol",
        stage: "notebook_shot_labels",
        input: expect.objectContaining({
          model: "gpt-5.6-sol",
          store: false,
        }),
        response: expect.objectContaining({
          status: "completed",
          model: "gpt-5.6-sol",
        }),
      }),
    ]);
    expect(savedAnalysis.boundaries).toEqual([
      expect.objectContaining({ kind: "source_start", timestampSeconds: 0 }),
      expect.objectContaining({ kind: "camera_cut", timestampSeconds: 15 }),
      expect.objectContaining({ kind: "source_end", timestampSeconds: 30 }),
    ]);
    expect(sourceExtractAudio?.slot).toEqual({ row: 1, column: 4 });
    const featureColumns = [1, 5];
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const column = featureColumns[ordinal - 1];
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `split-video-${ordinal}`)?.slot)
        .toEqual({ row: 3, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-video-${ordinal}`)?.slot)
        .toEqual({ row: 4, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `frame-first-${ordinal}`)?.slot)
        .toEqual({ row: 5, column: column - 1 });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `frame-last-${ordinal}`)?.slot)
        .toEqual({ row: 5, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-extract-audio-${ordinal}`)?.slot)
        .toEqual({ row: 5, column: column + 1 });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `prompt-${ordinal}`)?.slot)
        .toEqual({ row: 6, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `animate-${ordinal}`)?.slot)
        .toEqual({ row: 7, column });
    }
    expect(assembly?.slot).toEqual({ row: 8, column: 3 });
    expect(assembly?.label).toBe("Concat scenes");
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
      targetInput: "segment",
    }));
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: sourceExtractAudio?.id,
      target: assembly?.id,
      targetInput: "audio",
    }));
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const split = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `split-video-${ordinal}`);
      const video = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-video-${ordinal}`);
      const extractAudio = first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-extract-audio-${ordinal}`);
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: source?.id,
        target: split?.id,
        targetInput: "video",
      }));
      expect(first.edges).toContainEqual(expect.objectContaining({
        source: analysisOutput?.id,
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
        targetInput: "segment",
      }));
      expect(extractAudio?.type).toBe("audio");
      expect(extractAudio?.outputArtifactId).toBeTruthy();
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
      source: sourceExtractAudio?.id,
      target: assembly?.id,
      targetInput: "audio",
    }));
    if (!analysis) throw new Error("analysis cell missing");
    const manual = engine.notebooks.createCell({
      type: "prompt",
      label: "Manual note",
      slot: { row: 9, column: 0 },
    });
    const legacyWritten = await engine.notebooks.write({
      ...first,
      cells: [
        ...first.cells.map((cell) =>
          cell.id === analysis.id
            ? {
                ...cell,
                inputs: {
                  ...(cell.inputs ?? {}),
                  fixtureAnalysis: {
                    scenes: [{ title: "legacy", timestamp: [0, 30] }],
                  },
                },
              }
            : cell),
        manual,
      ],
    });
    if (!legacyWritten.ok) throw new Error(legacyWritten.error.message);
    const cleaned = await seedMultycultyWorkflow(engine);
    expect(cleaned.cells.find((cell) => cell.id === analysis.id)?.inputs)
      .not.toHaveProperty("fixtureAnalysis");
    expect(cleaned.cells.some((cell) => cell.id === manual.id)).toBe(true);
    expect(cleaned.cells.filter((cell) =>
      cell.inputs?.fixtureOwner === "multyculty-default").map((cell) => cell.id))
      .toEqual(first.cells.map((cell) => cell.id));
    const rerun = await applyAnalysisResults(engine, first, analysis.id, {
      rawOutput: {
        scenes: [
          { title: "intro", timestamp: [0, 15] },
          { title: "culture", timestamp: [15, 30] },
        ],
      },
      sourceDurationSeconds: 30,
      request: { mode: "multyculty-fixture" },
      sourceArtifactId: sourceId,
      materializeWorkflow: true,
    });
    const firstLayout = first.cells
      .map((cell) => ({ id: cell.id, slot: cell.slot }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const rerunLayout = rerun.cells
      .map((cell) => ({ id: cell.id, slot: cell.slot }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(rerun.cells).toHaveLength(19);
    expect(rerunLayout).toEqual(firstLayout);
    expect(new Set(rerun.cells.map((cell) =>
      `${cell.slot.row}:${cell.slot.column}`)).size).toBe(19);
    const rerunWritten = await engine.notebooks.write(rerun);
    expect(rerunWritten.ok).toBe(true);
    const downgraded = await engine.notebooks.write({
      ...rerun,
      fixture: { version: 0 },
    });
    expect(downgraded.ok).toBe(true);
    const second = await seedMultycultyWorkflow(engine);
    expect(second.cells).toHaveLength(19);
    expect(second.edges).toHaveLength(34);
    expect(second.cells.filter((cell) => cell.operation === "split_range")).toHaveLength(2);
    expect(second.cells.find((cell) => cell.inputs?.workflowRole === "source")?.id)
      .not.toBe(source?.id);
    expect(engine.files.listSubdir(sourceId, "original_frames"))
      .toEqual(sourceFrames);
  }, 90_000);
});
