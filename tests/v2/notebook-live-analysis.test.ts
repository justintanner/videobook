import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OpenAiResponseRequest,
  OpenAiResponseResponse,
} from "@apicity/openai";
import { createEngine, type Engine } from "videobook-engine";
import {
  analyzeNotebookSource,
  sampleNotebookAnalysisFrames,
} from "../../server/src/notebook-live-analysis.js";
import { runNotebookCell } from "../../server/src/jobs/run-notebook.js";
import { buildSevenStageScaffold } from "../../server/src/notebook-workflow.js";

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
            startSeconds: 0,
            endSeconds: 15,
            label: "Introduction",
            prompt: "The speaker introduces the setting.",
          },
          {
            startSeconds: 15,
            endSeconds: 30,
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
      { responses },
    );

    expect(captured).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "medium" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "notebook_analysis_shots",
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
      reasoning: { effort: "medium" },
      mode: "live",
      transcriptIncluded: true,
    });
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

  it("runs legacy Analyze live and persists normalized metadata and provenance", async () => {
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
            startSeconds: 0,
            endSeconds: 15,
            label: "Opening",
            prompt: "The opening visual beat.",
          },
          {
            startSeconds: 15,
            endSeconds: 30,
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
      reasoning: { effort: "medium" },
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
      request: Record<string, unknown>;
      raw: { shots: unknown[] };
    };
    expect(saved.request).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { effort: "medium" },
      mode: "live",
    });
    expect(saved.raw.shots).toHaveLength(2);
  });
});
