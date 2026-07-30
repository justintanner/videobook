import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OpenAiResponseRequest,
  OpenAiResponseResponse,
} from "@apicity/openai";
import {
  createEngine,
  type Engine,
  type Transcript,
} from "videobook-engine";
import { runFfmpeg } from "../../server/src/ffmpeg.js";
import {
  analyzeNotebookSource,
  buildAudioCandidates,
  sampleNotebookAnalysisFrames,
} from "../../server/src/notebook-live-analysis.js";
import {
  MULTYCULTY_FIXTURE_OWNER,
  analysisFixtureForCell,
} from "../../server/src/notebook-fixtures.js";
import { runNotebookCell } from "../../server/src/jobs/run-notebook.js";
import {
  DEFAULT_ANALYSIS_PROMPT,
  buildSevenStageScaffold,
} from "../../server/src/notebook-workflow.js";

function response(output: unknown): OpenAiResponseResponse {
  return {
    id: "resp_notebook_analysis",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5.6-sol",
    output: [{
      type: "message",
      id: "msg_notebook_analysis",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: JSON.stringify(output),
        annotations: [],
      }],
    }],
  };
}

function requestFormatName(request: OpenAiResponseRequest): string | null {
  return request.text?.format?.type === "json_schema"
    ? request.text.format.name
    : null;
}

function candidateFrames(timestampSeconds: number) {
  return [-0.5, -0.1, 0.1, 0.5].map((offsetSeconds) => ({
    timestampSeconds: timestampSeconds + offsetSeconds,
    offsetSeconds,
    dataUrl: "data:image/jpeg;base64,/9j/",
  }));
}

describe("notebook live analysis", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    engine?.close();
    if (rootDir) {
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  });

  it("only replays explicit fixtures outside the default workflow", () => {
    const fixture = { shots: [{ label: "Fixture" }] };

    expect(analysisFixtureForCell({
      inputs: { fixtureAnalysis: fixture },
    })).toBe(fixture);
    expect(analysisFixtureForCell({
      inputs: {
        fixtureOwner: MULTYCULTY_FIXTURE_OWNER,
        fixtureAnalysis: fixture,
      },
    })).toBeNull();
  });

  it("samples at most 15 timestamped frames in chronological order", () => {
    const names = [
      "ignore.json",
      ...Array.from({ length: 20 }, (_, index) =>
        `${String(19 - index).padStart(2, "0")}.000.jpg`),
    ];
    const sampled = sampleNotebookAnalysisFrames(names);
    expect(sampled).toHaveLength(15);
    expect(sampled[0]).toEqual({
      name: "00.000.jpg",
      timestampSeconds: 0,
    });
    expect(sampled.at(-1)).toEqual({
      name: "19.000.jpg",
      timestampSeconds: 19,
    });
    expect(sampled.every((frame, index) =>
      index === 0
      || frame.timestampSeconds > sampled[index - 1]!.timestampSeconds))
      .toBe(true);
  });

  it("derives timed pauses, speaker changes, and audio events", () => {
    const transcript = {
      segments: [
        {
          kind: "speech",
          speaker: "speaker-a",
          range: {
            startTick: 0,
            durationTicks: 2500,
            timeBase: { numerator: 1, denominator: 1000 },
          },
          words: [
            { startTick: 0, durationTicks: 500, text: "hello" },
            { startTick: 2000, durationTicks: 500, text: "again" },
          ],
        },
        {
          kind: "speech",
          speaker: "speaker-b",
          range: {
            startTick: 4000,
            durationTicks: 500,
            timeBase: { numerator: 1, denominator: 1000 },
          },
          words: [
            { startTick: 4000, durationTicks: 500, text: "response" },
          ],
        },
        {
          kind: "music",
          range: {
            startTick: 5000,
            durationTicks: 1000,
            timeBase: { numerator: 1, denominator: 1000 },
          },
          words: [],
        },
      ],
    } as unknown as Transcript;

    const candidates = buildAudioCandidates(transcript, [], 10);

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "pause",
        detail: expect.stringContaining('"hello"'),
      }),
      expect.objectContaining({
        kind: "speaker_change",
        timestampSeconds: 4,
      }),
      expect.objectContaining({
        kind: "music",
        timestampSeconds: 5,
      }),
    ]));
  });

  it("sends timestamped frames and an optional transcript through Responses", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-live-analysis-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "live-analysis",
    });
    await engine.ready;
    const source = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    await engine.metadata.artifacts.write(
      source.value.artifactId,
      "original",
      { duration: 30 },
    );
    for (let index = 0; index < 20; index += 1) {
      await engine.files.write(
        source.value.artifactId,
        `original_frames/${index.toFixed(3)}.jpg`,
        Buffer.from([index]),
      );
    }
    await engine.files.write(
      source.value.artifactId,
      "elevenlabs.json",
      JSON.stringify({ text: "A person introduces the scene." }),
    );
    let captured: OpenAiResponseRequest | undefined;
    const responses = async (
      request: OpenAiResponseRequest,
    ): Promise<OpenAiResponseResponse> => {
      captured = request;
      return response({
        shots: [
          {
            shotId: "shot-001",
            label: "Introduction",
            prompt: "The speaker introduces the setting.",
          },
          {
            shotId: "shot-002",
            label: "Demonstration",
            prompt: "The speaker demonstrates the workflow.",
          },
        ],
      });
    };

    const result = await analyzeNotebookSource(
      engine,
      source.value.artifactId,
      "Segment the narrative.",
      { responses, visualEvidence: [] },
    );

    expect(captured).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "high" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "notebook_shot_labels",
          strict: true,
        },
      },
    });
    const input = Array.isArray(captured?.input) ? captured.input[0] : null;
    const content = input && "content" in input && Array.isArray(input.content)
      ? input.content
      : [];
    expect(content.filter((part) => part.type === "input_image"))
      .toHaveLength(15);
    const labels = content.filter((part) =>
      part.type === "input_text"
      && part.text.startsWith("Frame timestamp:"));
    expect(labels).toHaveLength(15);
    expect(labels[0]).toMatchObject({
      text: "Frame timestamp: 0.000 seconds",
    });
    expect(labels.at(-1)).toMatchObject({
      text: "Frame timestamp: 19.000 seconds",
    });
    expect(content[0]).toMatchObject({
      type: "input_text",
      text: expect.stringContaining("A person introduces the scene."),
    });
    expect(result.rawOutput.shots).toHaveLength(2);
    expect(result.request).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { effort: "high" },
      mode: "live",
      pipelineVersion: 3,
      transcriptIncluded: true,
    });
    expect(result.llmExchanges).toHaveLength(1);
    expect(result.llmExchanges[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      stage: "notebook_shot_labels",
      input: {
        model: "gpt-5.6-sol",
        reasoning: { effort: "high" },
        store: false,
      },
      response: {
        id: "resp_notebook_analysis",
        status: "completed",
      },
    });
    expect(result.boundaries.map((boundary) => boundary.kind)).toEqual([
      "source_start",
      "duration_fallback",
      "source_end",
    ]);
  });

  it("preserves rapid verified camera cuts and rechecks ambiguous candidates", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-camera-cuts-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "camera-cuts",
    });
    await engine.ready;
    const source = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    await engine.metadata.artifacts.write(
      source.value.artifactId,
      "original",
      { duration: 20 },
    );
    for (const timestamp of [0, 5, 10, 15, 19]) {
      await engine.files.write(
        source.value.artifactId,
        `original_frames/${timestamp.toFixed(3)}.jpg`,
        Buffer.from([timestamp]),
      );
    }
    const requests: OpenAiResponseRequest[] = [];
    let validationCall = 0;
    const responses = async (
      request: OpenAiResponseRequest,
    ): Promise<OpenAiResponseResponse> => {
      requests.push(request);
      const name = requestFormatName(request);
      if (name === "notebook_camera_cut_validation") {
        validationCall += 1;
        return response({
          decisions: validationCall === 1
            ? [
                {
                  candidateId: "visual-001",
                  cameraSwitch: true,
                  transitionType: "hard_cut",
                  confidence: 0.95,
                },
                {
                  candidateId: "visual-002",
                  cameraSwitch: true,
                  transitionType: "hard_cut",
                  confidence: 0.5,
                },
              ]
            : [{
                candidateId: "visual-002",
                cameraSwitch: true,
                transitionType: "dissolve",
                confidence: 0.9,
              }],
        });
      }
      if (name === "notebook_shot_labels") {
        return response({
          shots: Array.from({ length: 4 }, (_, index) => ({
            shotId: `shot-${String(index + 1).padStart(3, "0")}`,
            label: `Shot ${index + 1}`,
            prompt: `Evidence-grounded shot ${index + 1}.`,
          })),
        });
      }
      throw new Error(`Unexpected request: ${name}`);
    };

    const result = await analyzeNotebookSource(
      engine,
      source.value.artifactId,
      "Find camera switches.",
      {
        responses,
        visualEvidence: [
          {
            id: "visual-001",
            timestampSeconds: 2,
            score: 18,
            frames: candidateFrames(2),
          },
          {
            id: "visual-002",
            timestampSeconds: 3,
            score: 12,
            frames: candidateFrames(3),
          },
        ],
      },
    );

    expect(result.boundaries.map((boundary) => [
      boundary.timestampSeconds,
      boundary.kind,
    ])).toEqual([
      [0, "source_start"],
      [2, "camera_cut"],
      [3, "camera_cut"],
      [11.5, "duration_fallback"],
      [20, "source_end"],
    ]);
    expect(result.rawOutput.shots[1]).toMatchObject({
      startSeconds: 2,
      endSeconds: 3,
    });
    expect(result.evidence.visualDecisions).toEqual([
      expect.objectContaining({
        candidateId: "visual-001",
        accepted: true,
        rechecked: false,
      }),
      expect.objectContaining({
        candidateId: "visual-002",
        accepted: true,
        transitionType: "dissolve",
        rechecked: true,
      }),
    ]);
    const validationRequests = requests.filter((request) =>
      requestFormatName(request) === "notebook_camera_cut_validation");
    expect(validationRequests).toHaveLength(2);
    expect(validationRequests[0]?.reasoning).toEqual({ effort: "high" });
    expect(validationRequests[1]?.reasoning).toEqual({ effort: "high" });
    expect(result.llmExchanges.map((exchange) => exchange.stage)).toEqual([
      "notebook_camera_cut_validation",
      "notebook_camera_cut_validation",
      "notebook_shot_labels",
    ]);
  });

  it("runs real scene detection and candidate-frame extraction before validation", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-camera-pipeline-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "camera-pipeline",
    });
    await engine.ready;
    const videoPath = join(rootDir, "camera-pipeline.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1:r=12",
      "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1:r=12",
      "-f", "lavfi", "-i", "color=c=green:s=64x64:d=1:r=12",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      videoPath,
    ]);
    const source = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    await engine.files.write(
      source.value.artifactId,
      "original.mp4",
      await readFile(videoPath),
    );
    await engine.metadata.artifacts.write(
      source.value.artifactId,
      "original",
      { duration: 3 },
    );
    for (const timestamp of [0, 1, 2]) {
      await engine.files.write(
        source.value.artifactId,
        `original_frames/${timestamp.toFixed(3)}.jpg`,
        Buffer.from([timestamp]),
      );
    }
    const responses = async (
      request: OpenAiResponseRequest,
    ): Promise<OpenAiResponseResponse> => {
      const name = requestFormatName(request);
      if (name === "notebook_camera_cut_validation") {
        const input = Array.isArray(request.input) ? request.input[0] : null;
        const content = input && "content" in input && Array.isArray(input.content)
          ? input.content
          : [];
        const ids = [...new Set(content.flatMap((part) => {
          if (part.type !== "input_text") return [];
          const match = /Candidate (visual-\d+)/.exec(part.text);
          return match?.[1] ? [match[1]] : [];
        }))];
        return response({
          decisions: ids.map((candidateId) => ({
            candidateId,
            cameraSwitch: true,
            transitionType: "hard_cut",
            confidence: 0.95,
          })),
        });
      }
      if (name === "notebook_shot_labels") {
        return response({
          shots: [1, 2, 3].map((ordinal) => ({
            shotId: `shot-${String(ordinal).padStart(3, "0")}`,
            label: `Color shot ${ordinal}`,
            prompt: `Solid-color shot ${ordinal}.`,
          })),
        });
      }
      throw new Error(`Unexpected request: ${name}`);
    };

    const result = await analyzeNotebookSource(
      engine,
      source.value.artifactId,
      "Detect each camera cut.",
      { responses },
    );

    expect(result.evidence.visualCandidates).toHaveLength(2);
    expect(result.evidence.visualCandidates.every((candidate) =>
      candidate.frameTimestamps.length === 4)).toBe(true);
    const cameraCuts = result.boundaries.filter((boundary) =>
      boundary.kind === "camera_cut");
    expect(cameraCuts).toHaveLength(2);
    expect(cameraCuts[0]?.timestampSeconds).toBeCloseTo(1, 1);
    expect(cameraCuts[1]?.timestampSeconds).toBeCloseTo(2, 1);
    expect(result.rawOutput.shots).toHaveLength(3);
  });

  it("chooses a waveform transition instead of an arbitrary long-take split", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-audio-cuts-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "audio-cuts",
    });
    await engine.ready;
    const source = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    await engine.metadata.artifacts.write(
      source.value.artifactId,
      "original",
      { duration: 30 },
    );
    await engine.metadata.waveforms.write(
      source.value.artifactId,
      Array.from({ length: 59 }, (_, index) => index === 29 ? 0.05 : 0.8),
    );
    for (const timestamp of [0, 10, 20, 29]) {
      await engine.files.write(
        source.value.artifactId,
        `original_frames/${timestamp.toFixed(3)}.jpg`,
        Buffer.from([timestamp]),
      );
    }
    const responses = async (
      request: OpenAiResponseRequest,
    ): Promise<OpenAiResponseResponse> => {
      const name = requestFormatName(request);
      if (name === "notebook_audio_boundary_selection") {
        const input = Array.isArray(request.input) ? request.input[0] : null;
        const content = input && "content" in input && Array.isArray(input.content)
          ? input.content
          : [];
        const text = content.find((part) => part.type === "input_text");
        const payload = JSON.parse(text?.type === "input_text" ? text.text : "{}") as {
          targets: Array<{ id: string }>;
          candidates: Array<{ id: string; kind: string }>;
        };
        const selected = payload.candidates.find((candidate) =>
          candidate.kind === "waveform_minimum");
        return response({
          selections: [{
            targetId: payload.targets[0]!.id,
            candidateId: selected?.id ?? null,
          }],
        });
      }
      if (name === "notebook_shot_labels") {
        return response({
          shots: [
            {
              shotId: "shot-001",
              label: "Before pause",
              prompt: "The first continuous take before the audio pause.",
            },
            {
              shotId: "shot-002",
              label: "After pause",
              prompt: "The continuous take resumes after the audio pause.",
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${name}`);
    };

    const result = await analyzeNotebookSource(
      engine,
      source.value.artifactId,
      "Use audio continuity.",
      { responses, visualEvidence: [] },
    );

    expect(result.boundaries.map((boundary) => boundary.kind)).toEqual([
      "source_start",
      "audio_transition",
      "source_end",
    ]);
    expect(result.boundaries[1]?.timestampSeconds).toBe(15);
    expect(result.evidence.selectedAudioCandidateIds).toEqual([
      result.boundaries[1]?.evidenceIds[0],
    ]);
    expect(result.llmExchanges.map((exchange) => exchange.stage)).toEqual([
      "notebook_audio_boundary_selection",
      "notebook_shot_labels",
    ]);
    expect(result.rawOutput.shots.every((shot) =>
      shot.endSeconds - shot.startSeconds <= 15)).toBe(true);
  });

  it("caches a gpt-transcribe fallback when processed audio has no transcript", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-transcript-fallback-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "transcript-fallback",
    });
    await engine.ready;
    const source = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    await engine.metadata.artifacts.write(
      source.value.artifactId,
      "original",
      { duration: 10 },
    );
    await engine.files.write(
      source.value.artifactId,
      "original_frames/0.000.jpg",
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    await engine.files.write(
      source.value.artifactId,
      "original.mp3",
      Buffer.from("audio"),
    );
    let transcribeModel: FormDataEntryValue | null = null;
    vi.stubEnv("OPENAI_API_KEY", "transcript-key");
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (body instanceof FormData) transcribeModel = body.get("model");
      return new Response(JSON.stringify({ text: "Timed words are unavailable." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const responses = async (): Promise<OpenAiResponseResponse> =>
      response({
        shots: [{
          shotId: "shot-001",
          label: "Single take",
          prompt: "One continuous evidence-grounded take.",
        }],
      });

    const result = await analyzeNotebookSource(
      engine,
      source.value.artifactId,
      "Label the take.",
      { responses, visualEvidence: [] },
    );

    expect(transcribeModel).toBe("gpt-transcribe");
    expect(result.evidence.transcript).toMatchObject({
      included: true,
      timed: false,
      provider: "openai",
      model: "gpt-transcribe",
    });
    const cached = await engine.files.read(
      source.value.artifactId,
      ".analysis.gpt4otrans.json",
    );
    expect(cached.ok).toBe(true);
  });

  it("migrates legacy defaults while retaining a custom analysis brief", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-analysis-prompt-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "analysis-prompt",
    });
    await engine.ready;
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const initial = buildSevenStageScaffold(engine, notebook.value);
    const analysis = initial.cells.find((cell) =>
      cell.operation === "analyze_source");
    expect(analysis?.prompt).toBe(DEFAULT_ANALYSIS_PROMPT);
    if (!analysis) return;
    const custom = {
      ...initial,
      cells: initial.cells.map((cell) =>
        cell.id === analysis.id
          ? { ...cell, prompt: "Prioritize reaction shots." }
          : cell),
    };
    const rebuilt = buildSevenStageScaffold(engine, custom);
    expect(rebuilt.cells.find((cell) => cell.id === analysis.id)?.prompt)
      .toBe("Prioritize reaction shots.");
    const legacy = {
      ...custom,
      cells: custom.cells.map((cell) =>
        cell.id === analysis.id
          ? {
              ...cell,
              prompt:
                "Segment the source into four continuous 15-second narrative shots with precise timestamps and concise visual context.",
            }
          : cell),
    };
    const migrated = buildSevenStageScaffold(engine, legacy);
    expect(migrated.cells.find((cell) => cell.id === analysis.id)?.prompt)
      .toBe(DEFAULT_ANALYSIS_PROMPT);
  });

  it("requires a positive duration before calling the provider", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-live-duration-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "live-duration",
    });
    await engine.ready;
    const source = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    await expect(analyzeNotebookSource(
      engine,
      source.value.artifactId,
      "Segment",
      { responses: async () => response({ shots: [] }) },
    )).rejects.toThrow(/positive source duration/);
  });

  it("requires at least one processed timestamped frame", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-live-frames-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "live-frames",
    });
    await engine.ready;
    const source = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    await expect(analyzeNotebookSource(
      engine,
      source.value.artifactId,
      "Segment",
      {
        sourceDurationSeconds: 30,
        responses: async () => response({ shots: [] }),
      },
    )).rejects.toThrow(/processed original_frames/);
  });

  it("runs legacy fixture-owned Analyze live and persists normalized metadata and provenance", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-live-runner-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "live-runner",
    });
    await engine.ready;
    const source = await engine.artifacts.create({
      kind: "video",
      name: "source",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    await engine.metadata.artifacts.write(
      source.value.artifactId,
      "original",
      { duration: 30 },
    );
    await engine.files.write(
      source.value.artifactId,
      "original_frames/0.000.jpg",
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    await engine.files.write(
      source.value.artifactId,
      "original_frames/15.000.jpg",
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    const sourcePath = join(rootDir, "live-source.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:d=1:r=10",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast",
      sourcePath,
    ]);
    await engine.files.write(
      source.value.artifactId,
      "original.mp4",
      await readFile(sourcePath),
    );
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const scaffold = buildSevenStageScaffold(
      engine,
      notebook.value,
      source.value.artifactId,
    );
    const configured = {
      ...scaffold,
      cells: scaffold.cells.map((cell) =>
        cell.operation === "analyze_source"
          ? {
              ...cell,
              provider: "kie",
              model: "gemini-3.5-flash",
              tool: "kie_gemini_analysis",
              inputs: {
                ...(cell.inputs ?? {}),
                fixtureOwner: MULTYCULTY_FIXTURE_OWNER,
                fixtureAnalysis: {
                  shots: [{
                    startSeconds: 0,
                    endSeconds: 30,
                    label: "Fixture replay",
                    prompt: "This should never be returned.",
                  }],
                },
              },
            }
          : cell),
    };
    const written = await engine.notebooks.write(configured);
    expect(written.ok).toBe(true);
    const legacyAnalysis = configured.cells.find((cell) =>
      cell.operation === "analyze_source");
    expect(legacyAnalysis).toBeTruthy();
    if (!legacyAnalysis) return;
    let captured: OpenAiResponseRequest | undefined;
    vi.stubEnv("OPENAI_API_KEY", "live-analysis-key");
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as OpenAiResponseRequest;
      return new Response(JSON.stringify(response({
        shots: [
          {
            shotId: "shot-001",
            label: "Opening",
            prompt: "The opening visual beat.",
          },
          {
            shotId: "shot-002",
            label: "Closing",
            prompt: "The closing visual beat.",
          },
        ],
      })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      configured.id,
      configured,
      legacyAnalysis,
    );

    expect(captured).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "high" },
      store: false,
    });
    expect(result.status).toBe("completed");
    expect(result.document.cells.filter((cell) =>
      cell.operation === "split_range")).toHaveLength(2);
    expect(result.document.cells.find((cell) =>
      cell.id === legacyAnalysis.id)).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      tool: "openai_responses_analysis",
    });
    const artifact = await engine.files.read(
      result.outputArtifactId,
      "analysis.json",
    );
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    const saved = JSON.parse(artifact.value.toString()) as {
      version: number;
      request: Record<string, unknown>;
      llmExchanges: Array<{
        provider: string;
        model: string;
        stage: string;
        input: Record<string, unknown>;
        response: Record<string, unknown>;
      }>;
      raw: { shots: unknown[] };
      evidence: Record<string, unknown>;
      boundaries: unknown[];
    };
    expect(saved.version).toBe(3);
    expect(saved.request).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { effort: "high" },
      mode: "live",
    });
    expect(saved.llmExchanges).toHaveLength(1);
    expect(saved.llmExchanges[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      stage: "notebook_shot_labels",
      input: {
        model: "gpt-5.6-sol",
        reasoning: { effort: "high" },
        store: false,
      },
      response: {
        status: "completed",
        model: "gpt-5.6-sol",
      },
    });
    expect(saved.evidence).toBeTruthy();
    expect(saved.boundaries).toHaveLength(3);
    expect(saved.raw.shots).toHaveLength(2);
    expect(saved.raw.shots[0]).toMatchObject({
      label: "Opening",
    });
  });
});
