import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, FFPROBE, probeVideo } from "../ffmpeg.js";
import { renderGoalRemixAssembly, remixEditIdentity, type GoalRemixEdit } from "../goal-remix-assembly.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { testBudget } from "../test-budget.js";
import { cleanupSource } from "../video-cleanup/source.js";

const execFileAsync = promisify(execFile);

async function ffmpeg(args: string[]): Promise<string> {
  return (await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { timeout: testBudget(60_000), maxBuffer: 8 * 1024 * 1024 })).stdout;
}

async function colorAt(path: string, frame: number): Promise<number[]> {
  const { stdout } = await execFileAsync(FFMPEG, ["-v", "error", "-i", path, "-vf", `select=eq(n\\,${frame}),scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", timeout: testBudget(30_000) });
  return [...stdout];
}

async function frameSsim(output: string, original: string, frame: number): Promise<number> {
  const select = `select=eq(n\\,${frame}),format=gray,setpts=PTS-STARTPTS`;
  const text = await ffmpeg(["-i", output, "-i", original, "-filter_complex", `[0:v]${select}[out];[1:v]${select}[ref];[out][ref]ssim=stats_file=-`, "-f", "null", "-"]);
  const score = /All:([\d.]+)/u.exec(text)?.[1];
  if (!score) throw new Error("Could not measure the retained source frame");
  return Number(score);
}

describe("preserved-source remix assembly", () => {
  let root: string;
  let engine: Engine;
  let edit: GoalRemixEdit;
  let sourcePath: string;
  let clipPath: string;

  async function importVideo(path: string, label: string) {
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.writeFromPath(created.value.artifactId, "original.mp4", path);
    if (!written.ok) throw new Error(written.error.message);
    await registerMediaProbe(engine, created.value.artifactId, "original.mp4", await probeVideo(path));
    return { artifactId: created.value.artifactId, mediaHash: (await cleanupSource(engine, created.value.artifactId)).mediaHash };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-remix-assembly-"));
    engine = createEngineForTest(join(root, "book"));
    sourcePath = join(root, "source.mp4");
    clipPath = join(root, "action.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x284:rate=30:duration=14", "-f", "lavfi", "-i", "sine=frequency=330:duration=14:sample_rate=48000",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads", "2", sourcePath]);
    await ffmpeg(["-f", "lavfi", "-i", "color=yellow:size=160x284:rate=24:duration=2.75", "-f", "lavfi", "-i", "sine=frequency=880:duration=2.75:sample_rate=48000",
      "-vf", "drawbox=color=magenta:t=fill:enable='lt(t,0.75)'", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads", "2", clipPath]);
    const source = await importVideo(sourcePath, "Source montage");
    const clip = await importVideo(clipPath, "Longer action take");
    edit = { version: 1, original: source, source, clip, startFrame: 22, audio: "source",
      assembly: { version: 1, fps: 30, width: 160, height: 284, totalFrames: 420, changeStartFrame: 360, changeEndFrame: 420, fit: "contain" } };
  });

  afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

  it("keeps all source shots until frame 360, retains the reviewed ending and produces exactly 420 frames", async () => {
    const result = await renderGoalRemixAssembly(engine, edit, new AbortController().signal);
    const output = await cleanupSource(engine, result.artifactId);
    const probe = await probeVideo(output.path);
    expect(probe).toMatchObject({ width: 160, height: 284, fps: 30, videoDuration: 14, hasAudio: true });
    const { stdout } = await execFileAsync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", output.path], { timeout: testBudget(30_000) });
    expect(Number(stdout.trim())).toBe(420);
    for (const frame of [0, 120, 240, 359]) expect(await frameSsim(output.path, sourcePath, frame)).toBeGreaterThan(0.96);
    const firstAction = await colorAt(output.path, 360);
    const payoff = await colorAt(output.path, 419);
    expect(firstAction[0]).toBeGreaterThan(220);
    expect(payoff[0]).toBeGreaterThan(220);
    expect(payoff[1]).toBeGreaterThan(220);
    expect(payoff[2]).toBeLessThan(30);
    expect(await renderGoalRemixAssembly(engine, edit, new AbortController().signal)).toEqual(result);
    expect((await cleanupSource(engine, edit.original.artifactId)).mediaHash).toBe(edit.original.mediaHash);
    expect((await cleanupSource(engine, edit.clip.artifactId)).durationSeconds).toBe(2.75);
  });

  it("preserves the source suffix after a middle action without a transition or frozen tail", async () => {
    const middle = { ...edit, audio: "mute" as const, assembly: { ...edit.assembly, changeStartFrame: 150, changeEndFrame: 210 } };
    const result = await renderGoalRemixAssembly(engine, middle, new AbortController().signal);
    const output = await cleanupSource(engine, result.artifactId);
    expect(output.hasAudio).toBe(false);
    for (const frame of [149, 210, 419]) expect(await frameSsim(output.path, sourcePath, frame)).toBeGreaterThan(0.96);
    expect((await colorAt(output.path, 209))[1]).toBeGreaterThan(220);
  });

  it("contains a different generated aspect without cropping its payoff and supports an action at the start", async () => {
    const widePath = join(root, "wide.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=yellow:size=284x160:rate=24:duration=2.75", "-c:v", "libx264", "-pix_fmt", "yuv420p", widePath]);
    const wide = { ...edit, clip: await importVideo(widePath, "Wide action"), audio: "mute" as const,
      assembly: { ...edit.assembly, changeStartFrame: 0, changeEndFrame: 60 } };
    const output = await cleanupSource(engine, (await renderGoalRemixAssembly(engine, wide, new AbortController().signal)).artifactId);
    expect(output).toMatchObject({ width: 160, height: 284, durationSeconds: 14, fps: 30 });
    expect(await frameSsim(output.path, sourcePath, 60)).toBeGreaterThan(0.96);
    expect((await colorAt(output.path, 0))[0]).toBeLessThan(110);
  });

  it("rejects stale hashes, missing action frames and cancellation without caching a partial result", async () => {
    const stale = { ...edit, source: { ...edit.source, mediaHash: "changed" } };
    await expect(renderGoalRemixAssembly(engine, stale, new AbortController().signal)).rejects.toThrow("input changed");
    const pastEnd = { ...edit, startFrame: 30 };
    await expect(renderGoalRemixAssembly(engine, pastEnd, new AbortController().signal)).rejects.toThrow("missing frames");
    const controller = new AbortController();
    controller.abort();
    const cancelled = { ...edit, startFrame: 21 };
    await expect(renderGoalRemixAssembly(engine, cancelled, controller.signal)).rejects.toThrow();
    for (const failed of [stale, pastEnd, cancelled]) expect(engine.settings.get(`goal.assembly.${remixEditIdentity(failed)}`)).toBeNull();
  });

  it("keeps fractional source frame rates and validates the actual decoded frame count", async () => {
    const path = join(root, "fractional.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x284:rate=30000/1001", "-frames:v", "180", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
    const source = await importVideo(path, "Fractional-rate montage");
    const fractional = { ...edit, original: source, source, audio: "mute" as const,
      assembly: { ...edit.assembly, fps: 30000 / 1001, totalFrames: 180, changeStartFrame: 120, changeEndFrame: 180 } };
    const output = await cleanupSource(engine, (await renderGoalRemixAssembly(engine, fractional, new AbortController().signal)).artifactId);
    expect(output.fps).toBeCloseTo(30000 / 1001, 6);
    expect(output.durationSeconds).toBeCloseTo(180 * 1001 / 30000, 4);
    expect(await frameSsim(output.path, path, 119)).toBeGreaterThan(0.96);
  });
});
