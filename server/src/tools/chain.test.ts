import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob, pauseBookQueueForTests, resumeBookQueueForTests, waitForBookQueuesIdleForTests } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { copyVideoFixture, COMMON_VIDEO_FIXTURES } from "../test-media-fixtures.js";
import { getChainRun, waitForChainRun } from "../chain-executor.js";
import { planStackedChainFromQuery } from "../chain-plan.js";
import type { Client } from "@modelcontextprotocol/client";
import { withBookContext } from "../book-context.js";
import { chatActionPlanSchema, prepareVoiceChatAction } from "./chat.js";

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

async function toneAmplitudes(filePath: string, workDir: string): Promise<number[]> {
  const pcmPath = join(workDir, "mixed-audio.f32");
  await runFfmpeg(["-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", pcmPath]);
  const bytes = await readFile(pcmPath);
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  return [440, 880].map(frequency => {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const angle = 2 * Math.PI * frequency * index / 8000;
      real += samples[index]! * Math.cos(angle);
      imaginary += samples[index]! * Math.sin(angle);
    }
    return 2 * Math.hypot(real, imaginary) / samples.length;
  });
}

describe("chain MCP tool", () => {
  let client: Client;
  let tempDir: string;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let sourceId: string;
  let targetId: string;
  const originalElevenLabsKey = process.env.ELEVENLABS_API_KEY;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  afterEach(async () => {
    if (originalElevenLabsKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalElevenLabsKey;
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

  async function chainAction(
    action: "status" | "cancel" | "approve",
    chainId: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({
      name: "chain",
      arguments: { action, book_id: bookId, chain_id: chainId, ...extra },
    });
    const parsed = parseText(result);
    if (result.isError) throw new Error(String(parsed.text ?? "chain action failed"));
    return parsed;
  }

  type PublicStep = {
    id: string;
    tool: string;
    status: string;
    error: string | null;
    requires_approval: boolean;
    approved_at: string | null;
    review: { estimateUsd: number | null; estimateUnavailable: boolean; reason: string } | null;
  };

  function publicSteps(run: Record<string, unknown>): PublicStep[] {
    return run.steps as PublicStep[];
  }

  /** A free local step, then a paid generation the chain must stop before running. */
  function extractThenGenerate(): unknown[] {
    return [
      { id: "frame", tool: "extract_frame", params: { asset_id: "@b2", frame: "first" } },
      {
        id: "animate",
        tool: "generate_video",
        params: {
          model: "kie:bytedance/seedance-2-5",
          prompt: "Animate the frame",
          refs: { first_frame: { $ref: { step_id: "frame", output: "image_asset_id" } } },
          options: { duration: 5 },
        },
      },
    ];
  }

  it("stops before a paid step and reports what approving would spend", async () => {
    await setupBook("pause-paid");
    const accepted = await runChain(extractThenGenerate());
    const chainId = String(accepted.chain_id);
    const settled = await waitForChainRun(engine, chainId, 180_000);
    expect(settled.status).toBe("awaiting-approval");
    expect(settled.awaitingStepId).toBe("animate");

    const run = await chainAction("status", chainId);
    const steps = publicSteps(run);
    expect(steps.map((step) => step.status)).toEqual(["completed", "awaiting-approval"]);
    expect(steps[0]?.requires_approval).toBe(false);
    expect(steps[1]?.requires_approval).toBe(true);
    expect(steps[1]?.review?.reason).toContain("Step 2 of 2");
    // Nothing was dispatched: the free step produced media, the paid one did not.
    expect(steps[0]?.status).toBe("completed");
    expect(engine.jobs.queue.list({ type: "await_notebook_output" })).toHaveLength(0);
  });

  it("cancelling a waiting step rejects it and drops the rest, keeping finished work", async () => {
    await setupBook("reject-paid");
    const accepted = await runChain([
      ...extractThenGenerate(),
      { id: "manifest", tool: "asset_manifest", params: { asset_id: "@b2" } },
    ]);
    const chainId = String(accepted.chain_id);
    await waitForChainRun(engine, chainId, 180_000);

    const cancelled = await chainAction("cancel", chainId);
    expect(cancelled.status).toBe("cancelled");
    const steps = publicSteps(cancelled);
    expect(steps.map((step) => step.status)).toEqual(["completed", "rejected", "skipped"]);
    // The frame the first step made is still there; cancelling rolls nothing back.
    const finished = await waitForChainRun(engine, chainId, 180_000);
    const frameId = String(finished.steps[0]?.outputs?.image_asset_id);
    expect(engine.artifacts.get(frameId).ok).toBe(true);
  });

  it("approves a waiting step once, and a second approve changes nothing", async () => {
    await setupBook("approve-once");
    const accepted = await runChain(extractThenGenerate());
    const chainId = String(accepted.chain_id);
    await waitForChainRun(engine, chainId, 180_000);

    const approved = await chainAction("approve", chainId, { step_id: "animate", actor: "chat" });
    expect(approved.awaiting_step_id).toBeNull();
    expect(publicSteps(approved)[1]?.approved_at).not.toBeNull();

    // No provider key in tests, so the dispatch this approval authorised fails at
    // the key guard rather than reaching a provider. The transition is the point.
    const settled = await waitForChainRun(engine, chainId, 180_000);
    expect(settled.status).toBe("failed");
    expect(settled.steps[1]?.error).toContain("KIE_API_KEY");

    const again = await client.callTool({
      name: "chain",
      arguments: { action: "approve", book_id: bookId, chain_id: chainId, step_id: "animate" },
    });
    const secondApproval = parseText(again);
    expect(again.isError).toBeFalsy();
    expect(publicSteps(secondApproval)[1]?.status).toBe("failed");
  });

  it("keeps a paused chain paused across a restart", async () => {
    await setupBook("restart-paused");
    const accepted = await runChain(extractThenGenerate());
    const chainId = String(accepted.chain_id);
    await waitForChainRun(engine, chainId, 180_000);

    const { resumeOpenChains } = await import("../chain-executor.js");
    const { getAllToolDefs } = await import("./index.js");
    const defs = getAllToolDefs(engine);
    resumeOpenChains(engine, (name) => defs.find((entry) => entry.name === name));

    const after = await chainAction("status", chainId);
    expect(after.status).toBe("awaiting-approval");
    expect(publicSteps(after)[1]?.status).toBe("awaiting-approval");
  });

  it.each(["ready", "failed"] as const)("handles a %s generated audio result in a reviewed background and SFX chat chain", async outcome => {
    await setupBook(`audio-${outcome}`);
    const actualBookId = engine.book.get().bookId;
    const beforeProxy = await objectHash(engine, targetId, "proxy.mp4");
    await waitForBookQueuesIdleForTests();
    await pauseBookQueueForTests(actualBookId);
    process.env.ELEVENLABS_API_KEY = "test-key";
    const routed = await withBookContext({ bookId: actualBookId, engine }, () => prepareVoiceChatAction(engine, {
      book_id: actualBookId, notebook_id: notebookId,
      prompt: "add background and sfx to @c4 wood chipping ASMR rhythmic realistic sounds",
    }, {
      tool: "chain", message: "Add wood-chipping ambience and timed sound effects.",
      params: {
        action: "run", version: 1,
        steps: [
          { id: "ambience", tool: "generate_audio", params: { model: "elevenlabs:sound-generation", prompt: "Rhythmic wood chipping ASMR", options: { duration_seconds: 1 } } },
          { id: "mix", tool: "audio_mix", params: { target_asset_id: "@c4", layer_asset_id: { $ref: { step_id: "ambience", output: "asset_id" } }, volume: 35 } },
          { id: "sfx", tool: "apply_sfx", params: { asset_id: { $ref: { step_id: "mix", output: "target_asset_id" } }, sfx: [{ timestamp: 0.2, type: "impact", description: "Wooden shoes tap the floor", duration_seconds: 0.5 }] } },
          { id: "inspect", tool: "asset_manifest", params: { asset_id: { $ref: { step_id: "sfx", output: "asset_id" } } } },
        ],
      },
    }));
    expect(routed.isError, routed.content[0]?.text).toBeFalsy();
    const plan = chatActionPlanSchema.parse(parseText(routed));
    const applied = await client.callTool({ name: "chat", arguments: { book_id: bookId, action_plan: plan } });
    expect(applied.isError, JSON.stringify(applied.content)).toBeFalsy();
    const chainId = String(parseText(applied).chain_id);
    const paused = await waitForChainRun(engine, chainId, 15_000);
    expect(paused.status).toBe("awaiting-approval");
    expect(paused.awaitingStepId).toBe("ambience");
    expect(engine.jobs.queue.list({ type: "generate_media" })).toHaveLength(0);
    await chainAction("approve", chainId, { step_id: "ambience" });
    await expect.poll(() => getChainRun(engine, chainId)?.steps[0]?.outputs?.cell_id, { timeout: 15_000 }).toBeTypeOf("string");
    const pending = getChainRun(engine, chainId)!;
    const audioId = String(pending.steps[0]?.outputs?.asset_id);
    const outputCellId = String(pending.steps[0]?.outputs?.cell_id);
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const producer = notebook.value.cells.find(cell => cell.type === "generate_audio");
    expect(producer).toBeDefined();
    expect(notebook.value.cells.find(cell => cell.id === outputCellId)).toMatchObject({ type: "audio", outputArtifactId: audioId });
    expect(notebook.value.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: producer!.id, target: outputCellId })]));
    expect(notebook.value.execution?.[producer!.id]?.status).toBe("awaiting-output");
    expect(pending.steps.map(step => step.status)).toEqual(["running", "pending", "pending", "pending"]);
    expect(engine.jobs.queue.list({ type: "audio_mix" })).toHaveLength(0);
    const providerJob = engine.jobs.queue.dequeue(process.pid, 60_000);
    expect(providerJob).toMatchObject({ type: "generate_media", artifactId: audioId });
    if (!providerJob) throw new Error("Missing queued audio generation");
    if (outcome === "failed") {
      expect(await engine.jobs.queue.fail(providerJob.id, { error: { message: "Audio provider failed" }, allowRetry: false }, providerJob.fence)).toBe(true);
      const failed = await waitForChainRun(engine, chainId, 15_000);
      expect(failed.status).toBe("failed");
      expect(failed.steps.map(step => step.status)).toEqual(["failed", "skipped", "skipped", "skipped"]);
      const failedNotebook = engine.notebooks.read(notebookId);
      if (!failedNotebook.ok) throw new Error(failedNotebook.error.message);
      expect(failedNotebook.value.execution?.[producer!.id]?.status).toBe("error");
      expect(await objectHash(engine, targetId, "proxy.mp4")).toBe(beforeProxy);
      expect(engine.jobs.queue.list({ type: "audio_mix" })).toHaveLength(0);
      return;
    }
    const audioPath = join(tempDir, "generated-ambience.mp3");
    await runFfmpeg(["-y", "-i", await filePathFor(engine, sourceId, "original.mp4"), "-vn", "-c:a", "libmp3lame", audioPath]);
    expect((await engine.files.writeFromPath(audioId, "original.mp3", audioPath)).ok).toBe(true);
    expect(await engine.jobs.queue.complete(providerJob.id, { result: { success: true } })).toBe(true);
    await resumeBookQueueForTests(actualBookId);
    const mixed = await waitForChainRun(engine, chainId, 60_000);
    expect(mixed.status, mixed.error ?? "").toBe("awaiting-approval");
    expect(mixed.awaitingStepId).toBe("sfx");
    expect(mixed.steps.map(step => step.status)).toEqual(["completed", "completed", "awaiting-approval", "pending"]);
    expect(mixed.steps[1]?.outputs).toMatchObject({ target_asset_id: targetId, layer_asset_id: audioId });
    expect(mixed.steps[2]?.review?.params.asset_id).toBe(targetId);
    const settled = engine.notebooks.read(notebookId);
    if (!settled.ok) throw new Error(settled.error.message);
    expect(settled.value.execution?.[producer!.id]?.status).toBe("completed");
    expect(settled.value.execution?.[outputCellId]?.status).toBe("completed");
    expect(engine.jobs.queue.list({ type: "run_notebook" })).toHaveLength(0);
    expect(engine.jobs.queue.list({ type: "process_video", artifactId: targetId, states: ["queued", "running", "completing"] })).toHaveLength(0);
    expect(await objectHash(engine, targetId, "proxy.mp4")).not.toBe(beforeProxy);
    for (const amplitude of await toneAmplitudes(await filePathFor(engine, targetId, "original.mp4"), tempDir)) {
      expect(amplitude).toBeGreaterThan(0.015);
    }
    await chainAction("cancel", chainId);
    const cancelled = await waitForChainRun(engine, chainId, 15_000);
    expect(cancelled.steps.map(step => step.status)).toEqual(["completed", "completed", "rejected", "skipped"]);
    expect(engine.jobs.queue.list({ type: "apply_sfx" })).toHaveLength(0);
  }, 90_000);

  it("mixes into a previous audio output without waiting for a video preview", async () => {
    await setupBook("audio-target");
    const accepted = await runChain([
      { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
      { id: "mix", tool: "audio_mix", params: { target_asset_id: { $ref: { step_id: "extract", output: "audio_asset_id" } }, layer_asset_id: "@c4", volume: 35 } },
    ]);
    const finished = await waitForChainRun(engine, String(accepted.chain_id), 60_000);
    expect(finished.status, finished.error ?? "").toBe("completed");
    const audioId = String(finished.steps[0]?.outputs?.audio_asset_id);
    expect(finished.steps[1]?.outputs?.target_asset_id).toBe(audioId);
    expect(engine.jobs.queue.list({ type: "process_video", artifactId: audioId })).toHaveLength(0);
    for (const amplitude of await toneAmplitudes(await filePathFor(engine, audioId, "original.mp3"), tempDir)) {
      expect(amplitude).toBeGreaterThan(0.015);
    }
  }, 90_000);

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
