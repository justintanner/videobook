import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptCommandArgs, parseSlashCommandArgs, type ServerCommand } from "../../../src/lib/command-registry.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, FFPROBE, probeVideo } from "../ffmpeg.js";
import { toolSpendsMoney } from "../paid-tools.js";
import { waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { PLAIN_TRANSCRIPT_FILE, TIMED_TRANSCRIPT_FILE } from "../transcript-projection.js";
import type { WorkspaceAction } from "../workspace-action-contract.js";
import { createZoomPlan, zoomWindowAt, type ZoomInput, type ZoomWindow } from "../zoom.js";
import { getCanonicalCommands } from "./commands.js";

const execFileAsync = promisify(execFile);
const WIDTH = 324;
const HEIGHT = 576;
const FPS = 30;
const SECONDS = 4;
const PROVIDER_KEYS = [
  "OPENAI_API_KEY", "KIE_API_KEY", "ELEVENLABS_API_KEY", "FAL_API_KEY", "FAL_ADMIN_API_KEY",
  "XAI_API_KEY", "MACHGEN_API_KEY", "KIMI_CODING_API_KEY", "WAVESPEED_API_KEY", "DASHSCOPE_API_KEY",
] as const;

function text(result: { content?: unknown }): string {
  return (result.content as Array<{ text: string }>)[0]!.text;
}

function data(result: { content?: unknown }): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

async function ffmpeg(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024, timeout: testBudget(60_000) });
  return stdout;
}

async function audioPacketsHash(path: string): Promise<string> {
  return (await ffmpeg(["-i", path, "-map", "0:a", "-c", "copy", "-f", "md5", "pipe:1"])).trim();
}

async function videoShape(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames", "-of", "json", path,
  ]);
  return (JSON.parse(stdout) as { streams: Record<string, unknown>[] }).streams[0]!;
}

async function frameSsim(rendered: string, frame: number, original: string, window?: ZoomWindow): Promise<number> {
  const pick = `select='eq(n,${frame})',format=gray,setpts=PTS-STARTPTS`;
  const crop = window
    ? `,crop=${Math.round(window.width * WIDTH)}:${Math.round(window.height * HEIGHT)}:${Math.round(window.x * WIDTH)}:${Math.round(window.y * HEIGHT)},scale=${WIDTH}:${HEIGHT}:flags=bicubic`
    : "";
  const stats = await ffmpeg([
    "-i", rendered, "-i", original,
    "-filter_complex", `[0:v]${pick}[rendered];[1:v]${pick}${crop}[reference];[rendered][reference]ssim=stats_file=-`,
    "-f", "null", "-",
  ]);
  return Number(/All:([\d.]+)/u.exec(stats)![1]);
}

async function truncateToHeader(from: string, to: string): Promise<void> {
  const bytes = await readFile(from);
  let offset = 0;
  while (bytes.toString("latin1", offset + 4, offset + 8) !== "mdat") offset += bytes.readUInt32BE(offset);
  await writeFile(to, bytes.subarray(0, offset + 72));
}

describe("zoom_video tool", () => {
  let dir = "";
  let pattern = "";
  let damaged = "";
  let client: Client;
  let engine: Engine;
  let bookId = "";
  const savedKeys = new Map<string, string | undefined>();

  async function addVideo(label: string, fixture: string): Promise<string> {
    const asset = await engine.artifacts.create("video", label);
    if (!asset.ok) throw new Error(asset.error.message);
    const written = await engine.files.write(asset.value.artifactId, "original.mp4", await readFile(fixture));
    if (!written.ok) throw new Error(written.error.message);
    return asset.value.artifactId;
  }

  async function addSidecar(assetId: string, filename: string): Promise<void> {
    const written = await engine.files.write(assetId, filename, Buffer.from(JSON.stringify({ text: "hello" })));
    if (!written.ok) throw new Error(written.error.message);
  }

  async function fileNames(assetId: string): Promise<string[]> {
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return manifest.value.files.map((file) => file.name);
  }

  async function videoPath(assetId: string): Promise<string> {
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return join(manifest.value.path, "original.mp4");
  }

  async function zoomAction(): Promise<WorkspaceAction> {
    const listed = data(await client.callTool({ name: "list_workspace_actions", arguments: { detail: "full", ids: ["tool.zoom_video"] } }));
    const action = (listed.actions as WorkspaceAction[]).find((entry) => entry.id === "tool.zoom_video");
    if (!action) throw new Error("The action catalog has no tool.zoom_video");
    return action;
  }

  function zoomJobs(): number {
    return engine.jobs.queue.list({ type: "zoom_video" }).length;
  }

  function zoomReprocess(assetId: string): Record<string, unknown> | undefined {
    return engine.jobs.queue.list({ type: "process_video", artifactId: assetId })
      .map((job) => job.payload)
      .find((payload) => (payload.provenance as Record<string, unknown> | undefined)?.origin === "zoom");
  }

  function sourceRevisions(assetId: string): number {
    return engine.history.artifact(assetId, 1_000).filter((revision) => revision.details?.path === "original.mp4").length;
  }

  beforeAll(async () => {
    for (const key of PROVIDER_KEYS) {
      savedKeys.set(key, process.env[key]);
      delete process.env[key];
    }
    dir = await mkdtemp(join(tmpdir(), "videobook-zoom-tool-"));
    pattern = join(dir, "pattern.mp4");
    damaged = join(dir, "damaged.mp4");
    await ffmpeg([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${SECONDS}`,
      "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.05:seed=1:duration=${SECONDS}:sample_rate=48000`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart", pattern,
    ]);
    await truncateToHeader(pattern, damaged);
    engine = createEngineForTest(dir);
    bookId = engine.book.get().bookId;
    client = await createTestClient(dir);
  }, testBudget(60_000));

  afterAll(async () => {
    await client?.close();
    for (const [key, value] of savedKeys) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("is free, offered as a /zoom preview, and needs no confirmation", async () => {
    expect(toolSpendsMoney("zoom_video")).toBe(false);
    const action = await zoomAction();
    expect(action.command).toBe("/zoom");
    expect(action.interaction).toBe("preview");
    expect(action.confirmation).toBe("none");
  });

  it("runs /zoom @a1 1-2.5 1.5 with no provider key, keeping the clip and its sound", async () => {
    const assetId = await addVideo("Zoom target", pattern);
    await addSidecar(assetId, TIMED_TRANSCRIPT_FILE);
    const command = getCanonicalCommands().find((entry) => entry.command === "/zoom") as ServerCommand;
    const adapted = adaptCommandArgs(command.mcpTool?.adapter, parseSlashCommandArgs(command, `@${assetId} 1-2.5 1.5`));
    expect(adapted).toEqual({ asset_id: assetId, zooms: [{ start_seconds: 1, end_seconds: 2.5, scale: 1.5 }] });

    const result = await client.callTool({ name: "zoom_video", arguments: { ...adapted, book_id: bookId } });
    expect(result.isError, text(result)).toBeFalsy();
    const zoom = { start_seconds: 1, end_seconds: 2.5, scale: 1.5, focus_x: 0.5, focus_y: 0.5, ramp_in_seconds: 0.3, ramp_out_seconds: 0.3 };
    expect(data(result)).toMatchObject({ asset_id: assetId, status: "completed", zooms: [zoom], sounds: [] });
    await waitForBookQueuesIdleForTests();

    const zoomed = await videoPath(assetId);
    expect(await videoShape(zoomed)).toEqual(await videoShape(pattern));
    expect(await audioPacketsHash(zoomed)).toBe(await audioPacketsHash(pattern));
    const plan = createZoomPlan({ sourceDuration: SECONDS, sourceFps: FPS, zooms: [zoom] });
    const [before, held, after] = await Promise.all([
      frameSsim(zoomed, 15, pattern),
      frameSsim(zoomed, 52, pattern, zoomWindowAt(plan, 52 / FPS)),
      frameSsim(zoomed, 90, pattern),
    ]);
    expect(before).toBeGreaterThanOrEqual(0.97);
    expect(held).toBeGreaterThanOrEqual(0.96);
    expect(after).toBeGreaterThanOrEqual(0.97);
    expect(await fileNames(assetId)).toContain(TIMED_TRANSCRIPT_FILE);
    expect(zoomReprocess(assetId)).toMatchObject({
      force: true, skipDownstreamJobs: true, preserveAudioArtifacts: true, reviveVisualAnalysis: true,
      provenance: { origin: "zoom", zooms: [zoom] },
    });
  }, testBudget(120_000));

  it("mixes the zoom sounds in, drops the transcript and fully reprocesses", async () => {
    const assetId = await addVideo("Zoom with sound", pattern);
    await addSidecar(assetId, TIMED_TRANSCRIPT_FILE);
    await addSidecar(assetId, PLAIN_TRANSCRIPT_FILE);
    const result = await client.callTool({
      name: "zoom_video",
      arguments: { book_id: bookId, asset_id: `@${assetId}`, zooms: [{ start_seconds: 1, end_seconds: 2.5, scale: 1.5, sound: "zoom_in", return_sound: "zoom_out" }] },
    });
    expect(result.isError, text(result)).toBeFalsy();
    expect(data(result).sounds).toEqual([{ sound: "zoom_in", start_seconds: 0.89 }, { sound: "zoom_out", start_seconds: 2.2 }]);
    await waitForBookQueuesIdleForTests();
    const names = await fileNames(assetId);
    expect(names).not.toContain(TIMED_TRANSCRIPT_FILE);
    expect(names).not.toContain(PLAIN_TRANSCRIPT_FILE);
    const [source, zoomed] = await Promise.all([probeVideo(pattern), probeVideo(await videoPath(assetId))]);
    expect(Math.abs(zoomed.duration - source.duration)).toBeLessThanOrEqual(1 / FPS);
    const reprocess = zoomReprocess(assetId);
    expect(reprocess).toMatchObject({ force: true });
    expect(reprocess).not.toHaveProperty("skipDownstreamJobs");
  }, testBudget(120_000));

  it("lands two zooms with one job and one new version of the video", async () => {
    const assetId = await addVideo("Two zooms", pattern);
    const versions = sourceRevisions(assetId);
    const jobs = zoomJobs();
    const zooms: ZoomInput[] = [
      { start_seconds: 2.5, end_seconds: 3.5, scale: 1.5, focus_x: 1, focus_y: 0, ramp_in_seconds: 0, ramp_out_seconds: 0 },
      { start_seconds: 0.5, end_seconds: 1.5, scale: 2, focus_x: 0.5, focus_y: 0.25, ramp_in_seconds: 0, ramp_out_seconds: 0 },
    ];
    const result = await client.callTool({ name: "zoom_video", arguments: { book_id: bookId, asset_id: assetId, zooms } });
    expect(result.isError, text(result)).toBeFalsy();
    expect((data(result).zooms as Array<{ start_seconds: number }>).map((zoom) => zoom.start_seconds)).toEqual([0.5, 2.5]);
    await waitForBookQueuesIdleForTests();
    expect(zoomJobs()).toBe(jobs + 1);
    expect(sourceRevisions(assetId)).toBe(versions + 1);
    const plan = createZoomPlan({ sourceDuration: SECONDS, sourceFps: FPS, zooms });
    const zoomed = await videoPath(assetId);
    const [first, second] = await Promise.all([
      frameSsim(zoomed, 30, pattern, zoomWindowAt(plan, 1)),
      frameSsim(zoomed, 90, pattern, zoomWindowAt(plan, 3)),
    ]);
    expect(first).toBeGreaterThanOrEqual(0.96);
    expect(second).toBeGreaterThanOrEqual(0.96);
  }, testBudget(120_000));

  it.each([
    ["overlapping zooms", [{ start_seconds: 1, end_seconds: 2.5 }, { start_seconds: 2, end_seconds: 3 }], "End each zoom before the next one starts"],
    ["a start past the end", [{ start_seconds: 9 }], "Start at least one frame before the end"],
    ["a scale out of range", [{ start_seconds: 1, scale: 5 }], "scale must be from 1.05 to 3; got 5"],
    ["an unknown sound", [{ start_seconds: 1, end_seconds: 2, sound: "boom" }], "zoom_in"],
    ["a return sound without an end", [{ start_seconds: 1, return_sound: "zoom_out" }], "Give it an end_seconds, or leave return_sound out"],
    ["nine zooms", Array.from({ length: 9 }, (_, index) => ({ start_seconds: index * 0.4, end_seconds: index * 0.4 + 0.2 })), "Give from 1 to 8 zooms; got 9"],
  ])("rejects %s with a message that says what to change and enqueues nothing", async (_name, zooms, message) => {
    const assetId = await addVideo("Invalid zoom", pattern);
    const jobs = zoomJobs();
    const result = await client.callTool({ name: "zoom_video", arguments: { book_id: bookId, asset_id: assetId, zooms } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(zoomJobs()).toBe(jobs);
  });

  it("leaves the video as it was and no scratch files behind when FFmpeg fails", async () => {
    const assetId = await addVideo("Damaged", damaged);
    const original = await readFile(await videoPath(assetId));
    const versions = sourceRevisions(assetId);
    await waitForBookQueuesIdleForTests();
    const scratch = await mkdtemp(join(dir, "scratch-"));
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      const result = await client.callTool({ name: "zoom_video", arguments: { book_id: bookId, asset_id: assetId, zooms: [{ start_seconds: 1, end_seconds: 2 }] } });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/^Zoom failed: .*ffmpeg failed/u);
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    expect(await readdir(scratch)).toEqual([]);
    expect(await readFile(await videoPath(assetId))).toEqual(original);
    expect(sourceRevisions(assetId)).toBe(versions);
  }, testBudget(120_000));

  it("restores the unzoomed video from the version before the zoom", async () => {
    const assetId = await addVideo("Restore", pattern);
    const original = await readFile(await videoPath(assetId));
    const [beforeZoom] = engine.history.artifact(assetId);
    const result = await client.callTool({ name: "zoom_video", arguments: { book_id: bookId, asset_id: assetId, zooms: [{ start_seconds: 1 }] } });
    expect(result.isError, text(result)).toBeFalsy();
    await waitForBookQueuesIdleForTests();
    expect((await readFile(await videoPath(assetId))).equals(original)).toBe(false);
    const restored = await client.callTool({ name: "restore_asset_version", arguments: { book_id: bookId, asset_id: assetId, commit_hash: beforeZoom!.hash } });
    expect(restored.isError, text(restored)).toBeFalsy();
    expect((await readFile(await videoPath(assetId))).equals(original)).toBe(true);
  }, testBudget(120_000));
});
