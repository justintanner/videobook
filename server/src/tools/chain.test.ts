import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { copyVideoFixture, COMMON_VIDEO_FIXTURES } from "../test-media-fixtures.js";
import { waitForChainRun } from "../chain-executor.js";
import { planStackedChainFromQuery } from "../chain-plan.js";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

function parseText(result: { content: unknown; isError?: boolean }): Record<string, unknown> {
  const text = (result.content as TextContent)[0]?.text ?? "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

async function generateToneVideo(
  outputPath: string,
  frequency: number,
  color: string,
): Promise<void> {
  await copyVideoFixture({
    width: 160,
    height: 120,
    durationSec: 1,
    fps: 10,
    source: "color",
    color,
    audio: { frequency },
  }, outputPath);
}

async function uploadVideo(
  client: Client,
  bookId: string,
  videoPath: string,
  filename: string,
): Promise<string> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: bookId, filename, data },
  });
  expect(result.isError).toBeFalsy();
  return String(parseText(result).assetId);
}

async function dominantFrequencyHz(filePath: string, workDir: string): Promise<number> {
  const pcmPath = join(workDir, `tone-${process.pid}-${Date.now()}.f32`);
  await runFfmpeg([
    "-y",
    "-i", filePath,
    "-vn",
    "-ac", "1",
    "-ar", "8000",
    "-f", "f32le",
    pcmPath,
  ]);
  const buf = await readFile(pcmPath);
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index - 1] ?? 0) <= 0 && (samples[index] ?? 0) > 0) crossings += 1;
  }
  const duration = samples.length / 8000;
  return duration > 0 ? crossings / duration : 0;
}

async function filePathFor(
  engine: Engine,
  artifactId: string,
  filename: string,
): Promise<string> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  return join(manifest.value.path, filename);
}

async function objectHash(
  engine: Engine,
  artifactId: string,
  filename: string,
): Promise<string> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = manifest.value.files.find((entry) => entry.name === filename);
  if (!file) throw new Error(`${filename} missing`);
  return file.objectHash;
}

describe("chain MCP tool", () => {
  let client: Client;
  let tempDir: string;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let sourceId: string;
  let targetId: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  afterEach(async () => {
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function setupBook(label: string): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), `videobook-chain-${label}-`));
    engine = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "chain-proj" },
    });
    bookId = "chain-proj";
    const notebooks = parseText(await client.callTool({
      name: "list_notebooks",
      arguments: { book_id: bookId },
    }));
    const listed = Array.isArray(notebooks) ? notebooks : [];
    if (listed.length > 0) {
      notebookId = String((listed[0] as { id: string }).id);
    } else {
      notebookId = String(parseText(await client.callTool({
        name: "create_notebook",
        arguments: { book_id: bookId, name: "Chain" },
      })).id);
    }
    const sourcePath = join(tempDir, "source-440.mp4");
    const targetPath = join(tempDir, "target-880.mp4");
    await generateToneVideo(sourcePath, 440, "0x224466");
    await generateToneVideo(targetPath, 880, "0x662222");
    sourceId = await uploadVideo(client, bookId, sourcePath, "source.mp4");
    targetId = await uploadVideo(client, bookId, targetPath, "target.mp4");
    await client.callTool({
      name: "create_notebook_cell",
      arguments: {
        book_id: bookId,
        notebook_id: notebookId,
        cell: {
          type: "video",
          slot: { row: 1, column: 1 },
          output_artifact_id: sourceId,
        },
      },
    });
    await client.callTool({
      name: "create_notebook_cell",
      arguments: {
        book_id: bookId,
        notebook_id: notebookId,
        cell: {
          type: "video",
          slot: { row: 2, column: 3 },
          output_artifact_id: targetId,
        },
      },
    });
  }

  async function runChain(
    steps: unknown[],
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({
      name: "chain",
      arguments: {
        action: "run",
        version: 1,
        book_id: bookId,
        notebook_id: notebookId,
        ...(requestId ? { request_id: requestId } : {}),
        steps,
      },
    });
    const parsed = parseText(result);
    if (result.isError) {
      throw new Error(String(parsed.text ?? "chain failed"));
    }
    return parsed;
  }

  async function waitPublic(chainId: string): Promise<Record<string, unknown>> {
    const record = await waitForChainRun(engine, chainId, 180_000);
    return {
      kind: "chain-run",
      chain_id: record.chainId,
      status: record.status,
      error: record.error,
      steps: record.steps,
    };
  }

  it("lists chain as a public MCP tool", async () => {
    await setupBook("list");
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["chain", "list_chat_models"]),
    );
  });

  it("runs extract then replace with a previous-output $ref", async () => {
    await setupBook("extract-replace");
    const sourceHash = await objectHash(engine, sourceId, "original.mp4");
    const beforeProxy = await objectHash(engine, targetId, "proxy.mp4");
    const accepted = await runChain([
      { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
      {
        id: "replace",
        tool: "replace_video_audio",
        params: {
          asset_id: "@c4",
          audio_asset_id: { $ref: { step_id: "extract", output: "audio_asset_id" } },
        },
      },
    ]);
    expect(["accepted", "running", "completed"]).toContain(accepted.status);
    const finished = await waitPublic(String(accepted.chain_id));
    expect(finished.status).toBe("completed");
    const steps = finished.steps as Array<{
      status: string;
      tool: string;
      outputs: Record<string, unknown> | null;
    }>;
    expect(steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    const audioId = String(steps[0]?.outputs?.audio_asset_id);
    expect(audioId).toMatch(/-/);
    expect(await objectHash(engine, sourceId, "original.mp4")).toBe(sourceHash);
    const afterProxy = await objectHash(engine, targetId, "proxy.mp4");
    expect(afterProxy).not.toBe(beforeProxy);
    const sourceFreq = await dominantFrequencyHz(
      await filePathFor(engine, sourceId, "original.mp4"),
      tempDir,
    );
    const targetFreq = await dominantFrequencyHz(
      await filePathFor(engine, targetId, "original.mp4"),
      tempDir,
    );
    expect(sourceFreq).toBeGreaterThan(300);
    expect(sourceFreq).toBeLessThan(600);
    expect(Math.abs(targetFreq - sourceFreq)).toBeLessThan(80);
  }, 180_000);

  it("reuses a third local media tool in a valid $ref plan", async () => {
    await setupBook("trim-extract");
    const accepted = await runChain([
      {
        id: "trim",
        tool: "trim_video",
        params: { asset_id: "@b2", trim_start: 0, trim_end: 0.5 },
      },
      {
        id: "extract",
        tool: "extract_audio",
        params: {
          asset_id: { $ref: { step_id: "trim", output: "asset_id" } },
        },
      },
    ]);
    const finished = await waitPublic(String(accepted.chain_id));
    expect(finished.status).toBe("completed");
    const extract = (finished.steps as Array<{ outputs: Record<string, unknown> | null }>)[1];
    const audioId = String(extract?.outputs?.audio_asset_id);
    expect(await filePathFor(engine, audioId, "original.mp3")).toContain("original.mp3");
  }, 180_000);

  it("rejects invalid plans before dispatch", async () => {
    await setupBook("invalid");
    const artifactsBefore = engine.artifacts.list().length;
    const cases: Array<Record<string, unknown>> = [
      { steps: [] },
      {
        steps: Array.from({ length: 17 }, (_, index) => ({
          id: `s${index + 1}`,
          tool: "asset_manifest",
          params: { asset_id: sourceId },
        })),
      },
      { steps: [{ id: "x", tool: "not_a_tool", params: {} }] },
      { steps: [{ id: "x", tool: "chain", params: { action: "run" } }] },
      {
        steps: [
          {
            id: "replace",
            tool: "replace_video_audio",
            params: {
              asset_id: "@c4",
              audio_asset_id: {
                $ref: { step_id: "extract", output: "audio_asset_id" },
              },
            },
          },
          { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
        ],
      },
      {
        steps: [{
          id: "extract",
          tool: "extract_audio",
          params: { asset_id: "@b2", book_id: "019fcc00-0000-7000-8000-00000000ffff" },
        }],
      },
    ];
    for (const args of cases) {
      const result = await client.callTool({
        name: "chain",
        arguments: {
          action: "run",
          version: 1,
          book_id: bookId,
          notebook_id: notebookId,
          ...args,
        },
      });
      expect(result.isError).toBe(true);
    }
    expect(engine.artifacts.list().length).toBe(artifactsBefore);
  });

  it("returns the same run for a duplicate request_id and rejects a different plan", async () => {
    await setupBook("dedupe");
    const steps = [
      { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
    ];
    const requestId = "019fcc00-0000-7000-8000-00000000aaaa";
    const first = await runChain(steps, requestId);
    const second = await runChain(steps, requestId);
    expect(second.chain_id).toBe(first.chain_id);
    const conflict = await client.callTool({
      name: "chain",
      arguments: {
        action: "run",
        version: 1,
        book_id: bookId,
        notebook_id: notebookId,
        request_id: requestId,
        steps: [
          {
            id: "trim",
            tool: "trim_video",
            params: { asset_id: "@c4", trim_start: 0, trim_end: 0.4 },
          },
        ],
      },
    });
    expect(conflict.isError).toBe(true);
    await waitPublic(String(first.chain_id));
  }, 180_000);

  it("stops later steps on failure and reports skipped work", async () => {
    await setupBook("failure");
    const silentPath = join(tempDir, "silent.mp4");
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.extractAudioSilent, silentPath);
    const silentId = await uploadVideo(client, bookId, silentPath, "silent.mp4");
    await client.callTool({
      name: "create_notebook_cell",
      arguments: {
        book_id: bookId,
        notebook_id: notebookId,
        cell: {
          type: "video",
          slot: { row: 3, column: 0 },
          output_artifact_id: silentId,
        },
      },
    });
    const accepted = await runChain([
      { id: "extract", tool: "extract_audio", params: { asset_id: "@d1" } },
      {
        id: "replace",
        tool: "replace_video_audio",
        params: {
          asset_id: "@c4",
          audio_asset_id: { $ref: { step_id: "extract", output: "audio_asset_id" } },
        },
      },
    ]);
    const finished = await waitPublic(String(accepted.chain_id));
    expect(finished.status).toBe("failed");
    const steps = finished.steps as Array<{ status: string }>;
    expect(steps[0]?.status).toBe("failed");
    expect(steps[1]?.status).toBe("skipped");
  }, 180_000);

  it("cancels later steps without rolling back completed work", async () => {
    await setupBook("cancel");
    const accepted = await runChain([
      { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
      {
        id: "replace",
        tool: "replace_video_audio",
        params: {
          asset_id: "@c4",
          audio_asset_id: { $ref: { step_id: "extract", output: "audio_asset_id" } },
        },
      },
    ]);
    const cancelled = parseText(await client.callTool({
      name: "chain",
      arguments: {
        action: "cancel",
        book_id: bookId,
        chain_id: accepted.chain_id,
      },
    }));
    expect(["cancelled", "completed"]).toContain(cancelled.status);
    const finished = await waitPublic(String(accepted.chain_id));
    const steps = finished.steps as Array<{ status: string; outputs: Record<string, unknown> | null }>;
    if (finished.status === "cancelled") {
      expect(steps.some((step) => step.status === "skipped" || step.status === "cancelled")).toBe(true);
    }
  }, 180_000);

  it("does not deadlock concurrent chains on the media worker pool", async () => {
    await setupBook("concurrent");
    const runs = await Promise.all(Array.from({ length: 6 }, (_, index) => runChain([
      {
        id: "extract",
        tool: "extract_audio",
        params: { asset_id: "@b2" },
      },
    ], `019fcc00-0000-7000-8000-00000000aa0${index}`)));
    const finished = await Promise.all(
      runs.map((run) => waitPublic(String(run.chain_id))),
    );
    expect(finished.every((run) => run.status === "completed")).toBe(true);
  }, 180_000);

  it("routes the required natural-language request through chat to chain", async () => {
    await setupBook("chat-route");
    delete process.env.OPENAI_API_KEY;
    const routed = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "extract audio from b2 and use it to replace the audio on the video in c4",
        book_id: bookId,
        notebook_id: notebookId,
      },
    });
    expect(routed.isError).toBeFalsy();
    const plan = parseText(routed);
    expect(plan.tool).toBe("chain");
    expect(plan.routedTool).toBe("chain");
    expect(plan.confirmation).toMatchObject({ required: true });
    const steps = (plan.params as { steps: Array<{ tool: string; params: Record<string, unknown> }> })
      .steps;
    expect(steps.map((step) => step.tool)).toEqual([
      "extract_audio",
      "replace_video_audio",
    ]);
    expect(steps[1]?.params.audio_asset_id).toEqual({
      $ref: { step_id: "extract", output: "audio_asset_id" },
    });
    const tagged = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "extract audio from @b2 and use it to replace the audio on the video in @c4",
        book_id: bookId,
        notebook_id: notebookId,
      },
    });
    expect(parseText(tagged).tool).toBe("chain");
    const single = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "extract audio from @b2",
        book_id: bookId,
        notebook_id: notebookId,
      },
    });
    const singlePlan = parseText(single);
    expect(singlePlan.tool === "chain" || String(singlePlan.text ?? "").includes("OPENAI_API_KEY"))
      .toBeTruthy();
    if (!single.isError) expect(singlePlan.tool).not.toBe("chain");
    expect(planStackedChainFromQuery("trim @a1 to 2 seconds then extract audio from it")?.steps[0]?.tool)
      .toBe("trim_video");
  });
});

describe("waitForJob still works alongside chain", () => {
  it("exports waitForJob for child media jobs", () => {
    expect(typeof waitForJob).toBe("function");
  });
});
