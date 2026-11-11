import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import { findPrimaryMediaFile, type Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getChainRun, waitForChainRun } from "../chain-executor.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { readGoal, saveGoal } from "../goal-store.js";
import { pauseBookQueueForTests, resumeBookQueueForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import type { GraphicsDocument } from "../graphics/model.js";
import { appendGraphicsLayers } from "../graphics/model.js";
import { goalTestCharacters, goalTestVideo, settleGoalChain } from "../test-goals.js";
import { saveWatermarkProfile } from "../watermark-config.js";
import type { GoalSnapshot } from "./goal.js";

describe("goal finishing burns the saved watermark through the graphics renderer", () => {
  let root: string;
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let oldKie: string | undefined;
  let oldOpenAi: string | undefined;

  beforeEach(async () => {
    oldKie = process.env.KIE_API_KEY;
    oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.KIE_API_KEY = "test-goal-key";
    process.env.OPENAI_API_KEY = "test-goal-key";
    root = await mkdtemp(join(tmpdir(), "videobook-goal-finish-e2e-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Goals");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    await goalTestCharacters(engine, notebookId);
  });

  afterEach(async () => {
    await client?.close();
    if (oldKie === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = oldKie;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>) => client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  async function invoke(args: Record<string, unknown>): Promise<GoalSnapshot> {
    const result = await raw(args);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text) as GoalSnapshot;
  }
  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });
  const approve = (goal: GoalSnapshot) => invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
  const notebook = () => {
    const result = engine.notebooks.read(notebookId);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const textOf = (result: { content?: unknown }) => (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
  const settleChain = (chainId: string, kind: "image" | "video") => settleGoalChain(engine, root, chainId, kind);

  it("finishes a reviewed video with one cold-open copy and one copy that burns the TikTok handle and no QR code", async () => {
    const exec = promisify(execFile);
    async function mediaHash(artifactId: string): Promise<string> {
      const manifest = await engine.files.manifest(artifactId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const file = findPrimaryMediaFile(manifest.value.files, "video");
      if (!file) throw new Error(`missing video ${artifactId}`);
      return file.objectHash;
    }
    async function mediaProbe(artifactId: string) {
      const manifest = await engine.files.manifest(artifactId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const file = findPrimaryMediaFile(manifest.value.files, "video");
      if (!file) throw new Error(`missing video ${artifactId}`);
      return { file, probe: await probeVideo(join(manifest.value.path, file.name)) };
    }
    async function frameAt(artifactId: string, seconds: number): Promise<Buffer> {
      const media = await mediaProbe(artifactId);
      const manifest = await engine.files.manifest(artifactId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const frame = await exec(FFMPEG, [
        "-v", "error", "-ss", String(seconds), "-i", join(manifest.value.path, media.file.name),
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
      ], { encoding: "buffer", maxBuffer: 2_000_000 });
      return frame.stdout;
    }
    const regionMean = (left: Buffer, right: Buffer, width: number, box: { x: number; y: number; w: number; h: number }): number => {
      let sum = 0;
      let count = 0;
      for (let y = box.y; y < box.y + box.h; y += 1) {
        for (let x = box.x; x < box.x + box.w; x += 1) {
          const offset = (y * width + x) * 3;
          sum += Math.abs(left[offset]! - right[offset]!) + Math.abs(left[offset + 1]! - right[offset + 1]!) + Math.abs(left[offset + 2]! - right[offset + 2]!);
          count += 3;
        }
      }
      return count === 0 ? 0 : sum / count;
    };
    const coldOpens = () => engine.jobs.queue.list({ type: "edit_cold_open" }).length;
    const burns = () => engine.jobs.queue.list({ type: "burn_watermark" }).length;
    let latest: GoalSnapshot | null = null;
    async function awaitFinish(goalId: string): Promise<GoalSnapshot> {
      await resumeBookQueueForTests(bookId);
      try {
        await expect.poll(async () => {
          latest = await status(goalId);
          return `${latest.status}:${latest.finish?.status ?? "none"}:${latest.finish?.error ?? ""}`;
        }, { timeout: testBudget(120_000), interval: 500 }).toBe("completed:completed:");
      } finally {
        await pauseBookQueueForTests(bookId);
      }
      if (!latest?.finish || latest.finish.status !== "completed" || !latest.finalArtifactId) throw new Error("finish did not complete");
      return latest;
    }

    await pauseBookQueueForTests(bookId);
    const goal = await invoke({ action: "create", brief: "@a1 @a2 skate through the morning market" });
    const scene = await approve(goal);
    const sceneChainId = scene.chainId!;
    await settleChain(sceneChainId, "image");
    const reviewed = await status(goal.goalId);
    const video = await approve(reviewed);
    const videoChainId = video.chainId!;
    const videoArtifactId = await settleChain(videoChainId, "video");
    const sourceHash = await mediaHash(videoArtifactId);
    const sourceProbe = await mediaProbe(videoArtifactId);

    const suggested = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(suggested.coldOpen).toMatchObject({ startSeconds: 0, endSeconds: 2.3, analysisUsd: 0, sourceObjectHash: sourceHash });
    expect(suggested.finish).toMatchObject({ status: "review", sourceArtifactId: videoArtifactId, finalArtifactId: null });
    expect(suggested.finalArtifactId).toBeNull();
    expect(engine.jobs.queue.list({ type: "finish_goal" })).toHaveLength(0);
    expect(engine.jobs.queue.list({ type: "prepare_cold_open" })).toHaveLength(0);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);

    const queued = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 0.5 });
    expect(queued.finish).toMatchObject({ status: "running", sourceArtifactId: videoArtifactId, finalArtifactId: null, startSeconds: 0, endSeconds: 0.5 });
    const firstJobId = readGoal(engine, goal.goalId).finish?.jobId;
    expect(firstJobId).toEqual(queued.finish?.jobId);
    expect(typeof firstJobId).toBe("number");
    expect(engine.jobs.queue.get(firstJobId!)?.state).toBe("queued");
    const finished = await awaitFinish(goal.goalId);
    const coldOpenArtifactId = finished.finish?.coldOpenArtifactId;
    const finalArtifactId = finished.finalArtifactId;
    if (!coldOpenArtifactId || !finalArtifactId) throw new Error("missing finish artifacts");
    const coldProbe = await mediaProbe(coldOpenArtifactId);
    const finalProbe = await mediaProbe(finalArtifactId);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(coldOpenArtifactId)).not.toBe(sourceHash);
    expect(await mediaHash(finalArtifactId)).not.toBe(await mediaHash(coldOpenArtifactId));
    expect(coldProbe.probe).toMatchObject({ width: sourceProbe.probe.width, height: sourceProbe.probe.height, hasAudio: true });
    expect(finalProbe.probe).toMatchObject({ width: sourceProbe.probe.width, height: sourceProbe.probe.height, hasAudio: true });
    expect(coldProbe.probe.fps).toBeCloseTo(sourceProbe.probe.fps, 0);
    expect(finalProbe.probe.fps).toBeCloseTo(sourceProbe.probe.fps, 0);
    expect(Math.abs(coldProbe.probe.videoDuration - (sourceProbe.probe.videoDuration + 0.5))).toBeLessThan(0.25);
    expect(Math.abs(finalProbe.probe.videoDuration - coldProbe.probe.videoDuration)).toBeLessThan(0.5);
    const width = sourceProbe.probe.width;
    const height = sourceProbe.probe.height;
    const handleBox = { x: Math.round(width * 0.2), y: 0, w: Math.round(width * 0.6), h: Math.max(8, Math.round(height * 0.28)) };
    const quietBox = { x: 0, y: Math.round(height * 0.4), w: Math.round(width * 0.45), h: Math.round(height * 0.2) };
    const qrBox = { x: Math.round(width * 0.55), y: Math.round(height * 0.5), w: Math.round(width * 0.4), h: Math.round(height * 0.45) };
    const earlyFinal = await frameAt(finalArtifactId, 1);
    const earlyCold = await frameAt(coldOpenArtifactId, 1);
    const handleDelta = regionMean(earlyFinal, earlyCold, width, handleBox);
    const earlyQuiet = regionMean(earlyFinal, earlyCold, width, quietBox);
    expect(handleDelta, `handle ${handleDelta} quiet ${earlyQuiet}`).toBeGreaterThan(1);
    expect(handleDelta).toBeGreaterThan(earlyQuiet * 3);
    const lateAt = Math.max(0, coldProbe.probe.videoDuration - 1.2);
    const lateFinal = await frameAt(finalArtifactId, lateAt);
    const lateCold = await frameAt(coldOpenArtifactId, lateAt);
    const qrRegion = regionMean(lateFinal, lateCold, width, qrBox);
    const lateQuiet = regionMean(lateFinal, lateCold, width, { x: 0, y: 0, w: Math.round(width * 0.3), h: Math.round(height * 0.25) });
    expect(qrRegion, `qr ${qrRegion} quiet ${lateQuiet}`).toBeLessThan(1);
    expect(lateQuiet).toBeLessThan(1);
    expect(notebook().cells.some(cell => cell.outputArtifactId === videoArtifactId)).toBe(true);
    expect(notebook().cells.some(cell => cell.outputArtifactId === finalArtifactId)).toBe(true);
    expect(coldOpens()).toBe(1);
    expect(burns()).toBe(1);
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");

    const stored = readGoal(engine, goal.goalId);
    saveGoal(engine, {
      ...stored, status: "review",
      finish: stored.finish ? { ...stored.finish, status: "running", finalArtifactId: null, error: null } : stored.finish,
    });
    const recovered = await status(goal.goalId);
    expect(recovered).toMatchObject({ status: "completed", finalArtifactId });
    expect(recovered.finish?.coldOpenArtifactId).toBe(coldOpenArtifactId);
    expect(coldOpens()).toBe(1);
    expect(burns()).toBe(1);
    const finalHash = await mediaHash(finalArtifactId);
    const replay = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 0.5 });
    expect(replay.finalArtifactId).toBe(finalArtifactId);
    expect(replay.finish?.coldOpenArtifactId).toBe(coldOpenArtifactId);
    expect(await mediaHash(finalArtifactId)).toBe(finalHash);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(coldOpens()).toBe(1);
    expect(burns()).toBe(1);

    const changedRange = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 });
    expect(changedRange.finish).toMatchObject({ status: "running", finalArtifactId: null, sourceArtifactId: videoArtifactId });
    const abortedJobId = readGoal(engine, goal.goalId).finish?.jobId;
    expect(typeof abortedJobId).toBe("number");
    expect(engine.jobs.queue.get(abortedJobId!)?.state).toBe("queued");
    expect(await engine.jobs.queue.abort(abortedJobId!, "Finishing cancelled")).toBe(true);
    const aborted = await status(goal.goalId);
    expect(aborted.status).toBe("review");
    expect(aborted.finish?.status).toBe("failed");
    expect(aborted.finalArtifactId).toBeNull();
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");
    expect(textOf(await raw({ action: "retry", goal_id: goal.goalId }))).toContain("failed or was interrupted");
    expect(coldOpens()).toBe(1);
    const retried = await awaitFinish((await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 })).goalId);
    expect(retried.finalArtifactId).not.toBe(finalArtifactId);
    expect(retried.finish?.coldOpenArtifactId).not.toBe(coldOpenArtifactId);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(coldOpens()).toBe(2);
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");
    const secondFinal = retried.finalArtifactId!;

    await saveWatermarkProfile({ handle: "nightmarket" }, "tiktok", engine);
    const rewatermarked = await awaitFinish((await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 })).goalId);
    expect(rewatermarked.finalArtifactId).not.toBe(secondFinal);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(secondFinal)).not.toBe(sourceHash);
    expect(coldOpens()).toBe(3);
    const thirdFinal = rewatermarked.finalArtifactId!;
    const thirdHash = await mediaHash(thirdFinal);
    const burnsBeforeQr = burns();
    const coldOpensBeforeQr = coldOpens();

    await saveWatermarkProfile({ qrStartSeconds: 0.4, qrEndSeconds: 1.1 }, "tiktok", engine);
    const qrRewatermarked = await awaitFinish((await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 })).goalId);
    expect(qrRewatermarked.finalArtifactId).not.toBe(thirdFinal);
    expect(qrRewatermarked.finish?.coldOpenArtifactId).not.toBe(rewatermarked.finish?.coldOpenArtifactId);
    const fourthFinal = qrRewatermarked.finalArtifactId!;
    const fourthHash = await mediaHash(fourthFinal);
    expect(fourthHash).not.toBe(thirdHash);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(thirdFinal)).toBe(thirdHash);
    expect(coldOpens()).toBe(coldOpensBeforeQr + 1);
    expect(burns()).toBe(burnsBeforeQr + 1);

    const graphics = async <T>(args: Record<string, unknown>): Promise<T> => {
      const result = await client.callTool({ name: "video_graphics", arguments: { book_id: bookId, asset_id: videoArtifactId, ...args } });
      expect(result.isError, textOf(result)).toBeFalsy();
      return JSON.parse(textOf(result)) as T;
    };
    const look = await graphics<{ revision: string; document: GraphicsDocument }>({ watermark: true });
    const branded = await graphics<{ revision: string }>({
      watermark: true,
      op: "update",
      expected_revision: look.revision,
      document: appendGraphicsLayers(look.document, [{
        kind: "text",
        name: "Brand",
        position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" },
        width: 0.9,
        align: "left",
        plate: { color: "#FF00FF", opacity: 1, radius: 0 },
        items: [{ text: "Follow for more", size: 0.04, shadow: false }],
      }]),
    });
    expect(await graphics<{ template: { name: string } }>({ op: "save_watermark", expected_revision: branded.revision })).toMatchObject({ template: { name: "TikTok watermark" } });
    const brandedFinish = await awaitFinish((await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 })).goalId);
    const brandedFinal = brandedFinish.finalArtifactId!;
    expect(brandedFinal).not.toBe(fourthFinal);
    const magenta = (pixels: Buffer) => {
      let count = 0;
      for (let offset = 0; offset < pixels.length; offset += 3) {
        if (Math.abs(pixels[offset]! - 255) + pixels[offset + 1]! + Math.abs(pixels[offset + 2]! - 255) <= 90) count += 1;
      }
      return count;
    };
    expect(magenta(await frameAt(brandedFinal, 1))).toBeGreaterThan(40);
    expect(magenta(await frameAt(fourthFinal, 1))).toBe(0);
    expect(coldOpens()).toBe(coldOpensBeforeQr + 2);
    expect(burns()).toBe(burnsBeforeQr + 2);

    const cancelling = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1.5 });
    expect(cancelling.finish?.status).toBe("running");
    expect(engine.jobs.queue.get(readGoal(engine, goal.goalId).finish!.jobId!)?.state).toBe("queued");
    const cancelled = await invoke({ action: "cancel", goal_id: goal.goalId });
    expect(cancelled).toMatchObject({ status: "review" });
    expect(cancelled.finish?.status).toBe("cancelled");
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");
    expect(engine.jobs.queue.list().some(job => job.type.startsWith("generate_") && ["queued", "running", "completing"].includes(job.state))).toBe(false);
    expect(coldOpens()).toBe(coldOpensBeforeQr + 2);
    expect(burns()).toBe(burnsBeforeQr + 2);
    expect(await mediaHash(thirdFinal)).toBe(thirdHash);
    expect(await mediaHash(fourthFinal)).toBe(fourthHash);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);

    saveGoal(engine, {
      ...readGoal(engine, goal.goalId), status: "review",
      assembly: { sequenceId: "seq", startFrame: 0, durationFrames: 1, artifactIds: ["not-the-selected-video"] },
    });
    expect(textOf(await raw({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 0.5 }))).toContain("timeline clips were edited");
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);

    const combinedId = await goalTestVideo(engine, root, "green");
    const combinedHash = await mediaHash(combinedId);
    saveGoal(engine, {
      ...readGoal(engine, goal.goalId), status: "review",
      assembly: { sequenceId: "seq", startFrame: 0, durationFrames: 1, artifactIds: [videoArtifactId] },
      combined: { artifactId: combinedId, cellId: goal.cellId, jobId: null, status: "completed", error: null },
    });
    const combinedStart = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 0.5 });
    expect(combinedStart.finish).toMatchObject({ status: "running", sourceArtifactId: combinedId, finalArtifactId: null });
    const combinedDone = await awaitFinish(goal.goalId);
    expect(combinedDone.finish?.sourceArtifactId).toBe(combinedId);
    expect(combinedDone.finalArtifactId).not.toBe(combinedId);
    expect(await mediaHash(combinedId)).toBe(combinedHash);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(thirdFinal)).toBe(thirdHash);
    expect(await mediaHash(fourthFinal)).toBe(fourthHash);
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");

    const sceneBefore = combinedDone.stages.frame?.outputs[0]?.artifactId;
    const finalBefore = combinedDone.finalArtifactId;
    if (!sceneBefore || !finalBefore) throw new Error("missing the completed scene or final");
    const finalBeforeHash = await mediaHash(finalBefore);
    const regenerating = await invoke({
      action: "regenerate", goal_id: goal.goalId, revision: combinedDone.revision, stage: "frame", index: 0,
    });
    expect(regenerating).toMatchObject({ status: "running", finish: null });
    expect(readGoal(engine, goal.goalId).resumeStatus).toBe("completed");
    const stopped = await invoke({ action: "cancel", goal_id: goal.goalId });
    await waitForChainRun(engine, regenerating.chainId!);
    expect(stopped).toMatchObject({ status: "completed", finalArtifactId: finalBefore });
    expect(stopped.finish?.status).toBe("completed");
    expect((await status(goal.goalId)).finalArtifactId).toBe(finalBefore);
    const restarted = await invoke({
      action: "revise", goal_id: goal.goalId, revision: stopped.revision, stage: "frame", index: 0, feedback: "Raise the board",
    });
    expect(restarted).toMatchObject({ status: "running", finish: null });
    expect(readGoal(engine, goal.goalId).resumeStatus).toBe("completed");
    const regeneratedScene = await settleChain(restarted.chainId!, "image");
    expect(regeneratedScene).not.toBe(sceneBefore);
    const reopened = await status(goal.goalId);
    expect(reopened).toMatchObject({ status: "review", stage: "videos", finalArtifactId: null, finish: null });
    expect(reopened.stages.frame?.outputs[0]?.artifactId).toBe(regeneratedScene);
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(finalBefore)).toBe(finalBeforeHash);
  }, testBudget(300_000));
});
