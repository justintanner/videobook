import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { fftInPlace } from "../rhythm/fft.js";
import { testBudget } from "../test-budget.js";
import type { SegmentPlan, SegmentSource } from "./plan.js";
import { isVariableFrameRate, renderSegmentPlan, validateSegmentOutput } from "./render.js";

const execFileAsync = promisify(execFile);
const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const SAMPLE_RATE = 48_000;

async function runCmd(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: testBudget(60_000),
  });
  return stdout;
}

async function rawAudio(path: string, startSec?: number, durationSec?: number): Promise<Float32Array> {
  const seekArgs = startSec !== undefined ? ["-ss", String(startSec)] : [];
  const durArgs = durationSec !== undefined ? ["-t", String(durationSec)] : [];
  const { stdout } = await execFileAsync(FFMPEG, [
    "-hide_banner", "-v", "error", ...seekArgs, ...durArgs, "-i", path,
    "-map", "0:a:0", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: testBudget(60_000) });
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

function dominantFrequency(samples: Float32Array): number {
  const size = 2 ** Math.floor(Math.log2(samples.length));
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  for (let i = 0; i < size; i += 1) real[i] = samples[i]!;
  fftInPlace(real, imag);
  let best = 0;
  let bestHz = 0;
  for (let i = 1; i < size / 2; i += 1) {
    const power = real[i]! ** 2 + imag[i]! ** 2;
    if (power > best) {
      best = power;
      bestHz = (i * SAMPLE_RATE) / size;
    }
  }
  return bestHz;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

async function frameSsim(rendered: string, renderedFrame: number, source: string, sourceFrame: number): Promise<number> {
  const stats = await runCmd([
    "-i", rendered,
    "-i", source,
    "-filter_complex",
    `[0:v]select='eq(n,${renderedFrame})',format=gray,setpts=PTS-STARTPTS[a];[1:v]select='eq(n,${sourceFrame})',format=gray,setpts=PTS-STARTPTS[b];[a][b]ssim=stats_file=-`,
    "-f", "null", "-",
  ]);
  const match = /All:([\d.]+)/u.exec(stats);
  if (!match) throw new Error(`ssim produced no score: ${stats}`);
  return Number(match[1]);
}

function makeSource(overrides: Partial<SegmentSource> = {}): SegmentSource {
  return {
    artifactId: "fixture-1",
    sourceHash: "f".repeat(64),
    fps: FPS,
    frames: 120,
    width: WIDTH,
    height: HEIGHT,
    hasAudio: true,
    ...overrides,
  };
}

describe("segment plan rendering", () => {
  let dir = "";
  let mainClip = "";
  let silentClip = "";
  let toneClip = "";
  let syncClip = "";
  let ntscClip = "";
  let vfrClip = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "auto-edit-render-"));
    mainClip = join(dir, "main.mp4");
    silentClip = join(dir, "silent.mp4");
    toneClip = join(dir, "tone.mp4");
    syncClip = join(dir, "sync.mp4");
    ntscClip = join(dir, "ntsc.mp4");
    vfrClip = join(dir, "vfr.mp4");

    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=4`,
      "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.1:seed=1:sample_rate=${SAMPLE_RATE}:duration=4`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", mainClip,
    ]);
    await runCmd(["-i", mainClip, "-map", "0:v:0", "-c:v", "copy", "-an", silentClip]);
    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=2`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${SAMPLE_RATE}:duration=2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", toneClip,
    ]);
    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=4`,
      "-f", "lavfi", "-i", `aevalsrc=if(gte(t\\,2)\\,0.4*sin(2*PI*440*t)\\,0):s=${SAMPLE_RATE}:d=4`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", syncClip,
    ]);
    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=30000/1001:duration=3`,
      "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.1:seed=2:sample_rate=${SAMPLE_RATE}:duration=3`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", ntscClip,
    ]);
    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=4`,
      "-vf", "setpts='if(lt(N,60),N/30/TB,(60+(N-60)*2)/30/TB)'",
      "-vsync", "vfr",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
      "-an", vfrClip,
    ]);
  }, testBudget(90_000));

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("renders out-of-order overlapping segments frame-exact in one encode", async () => {
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource(),
      segments: [
        { id: "hook", role: "cold_open", startFrame: 60, endFrame: 90, speed: 1, motion: "repeat", audio: "source" },
        { id: "full", role: "body", startFrame: 0, endFrame: 120, speed: 1, motion: "repeat", audio: "source" },
        { id: "replay", role: "replay", startFrame: 60, endFrame: 90, speed: 1, motion: "repeat", audio: "source" },
      ],
    };
    const out = join(dir, "reordered.mp4");
    const result = await renderSegmentPlan(plan, mainClip, out);
    expect(result.frames).toBe(180);
    expect(result.probe.width).toBe(WIDTH);
    expect(result.probe.height).toBe(HEIGHT);
    expect(result.probe.fps).toBeCloseTo(FPS, 2);

    const checks: Array<[number, number]> = [
      [0, 60], [15, 75], [29, 89],
      [30, 0], [90, 60], [149, 119],
      [150, 60], [165, 75], [179, 89],
    ];
    for (const [outFrame, srcFrame] of checks) {
      const exact = await frameSsim(out, outFrame, mainClip, srcFrame);
      expect(exact, `out ${outFrame} vs src ${srcFrame}`).toBeGreaterThanOrEqual(0.98);
      if (srcFrame > 0) {
        const prev = await frameSsim(out, outFrame, mainClip, srcFrame - 1);
        expect(exact, `out ${outFrame} vs prev ${srcFrame - 1}`).toBeGreaterThan(prev);
      }
      if (srcFrame + 1 < 120) {
        const next = await frameSsim(out, outFrame, mainClip, srcFrame + 1);
        expect(exact, `out ${outFrame} vs next ${srcFrame + 1}`).toBeGreaterThan(next);
      }
    }
  }, testBudget(90_000));

  it("handles speed 0.5 with repeat, flow and blend motion, and speed 2", async () => {
    const repeatPlan: SegmentPlan = {
      version: 1,
      source: makeSource({ hasAudio: false }),
      segments: [{ id: "slow-rep", role: "crash", startFrame: 20, endFrame: 40, speed: 0.5, motion: "repeat", audio: "mute" }],
    };
    const repeatOut = join(dir, "slow-repeat.mp4");
    expect((await renderSegmentPlan(repeatPlan, silentClip, repeatOut)).frames).toBe(40);
    for (const pair of [0, 4, 10, 18]) {
      const withinPair = await frameSsim(repeatOut, pair * 2, repeatOut, pair * 2 + 1);
      const acrossPair = await frameSsim(repeatOut, pair * 2 + 1, repeatOut, pair * 2 + 2);
      expect(withinPair).toBeGreaterThanOrEqual(0.999);
      expect(withinPair).toBeGreaterThan(acrossPair);
    }

    for (const motion of ["flow", "blend"] as const) {
      const slowPlan: SegmentPlan = {
        version: 1,
        source: makeSource({ hasAudio: false }),
        segments: [{ id: `slow-${motion}`, role: "crash", startFrame: 20, endFrame: 36, speed: 0.5, motion, audio: "mute" }],
      };
      const slowOut = join(dir, `slow-${motion}.mp4`);
      expect((await renderSegmentPlan(slowPlan, silentClip, slowOut)).frames).toBe(32);
      for (const odd of [3, 9, 15, 21]) {
        const vsPrev = await frameSsim(slowOut, odd, slowOut, odd - 1);
        const vsNext = await frameSsim(slowOut, odd, slowOut, odd + 1);
        expect(vsPrev, `${motion} frame ${odd} vs ${odd - 1}`).toBeLessThan(0.995);
        expect(vsNext, `${motion} frame ${odd} vs ${odd + 1}`).toBeLessThan(0.995);
      }
    }

    const fastPlan: SegmentPlan = {
      version: 1,
      source: makeSource({ hasAudio: false }),
      segments: [{ id: "fast", role: "custom", startFrame: 0, endFrame: 60, speed: 2, motion: "repeat", audio: "mute" }],
    };
    const fastOut = join(dir, "fast.mp4");
    expect((await renderSegmentPlan(fastPlan, silentClip, fastOut)).frames).toBe(30);
  }, testBudget(90_000));

  it("preserves pitch for source, drops pitch for pitch, mutes for mute, and keeps audio synced", async () => {
    const tonePlan: SegmentPlan = {
      version: 1,
      source: makeSource({ frames: 60 }),
      segments: [
        { id: "src-slow", role: "body", startFrame: 0, endFrame: 30, speed: 0.5, motion: "repeat", audio: "source" },
        { id: "pitch-slow", role: "crash", startFrame: 0, endFrame: 30, speed: 0.5, motion: "repeat", audio: "pitch" },
        { id: "muted", role: "custom", startFrame: 0, endFrame: 30, speed: 1, motion: "repeat", audio: "mute" },
      ],
    };
    const toneOut = join(dir, "tone-out.mp4");
    expect((await renderSegmentPlan(tonePlan, toneClip, toneOut)).frames).toBe(150);

    const srcFreq = dominantFrequency(await rawAudio(toneOut, 0.2, 1.5));
    const pitchFreq = dominantFrequency(await rawAudio(toneOut, 2.2, 1.5));
    const muteRms = rms(await rawAudio(toneOut, 4.1, 0.8));
    expect(Math.abs(srcFreq - 440) / 440).toBeLessThanOrEqual(0.03);
    expect(Math.abs(pitchFreq - 220) / 220).toBeLessThanOrEqual(0.03);
    expect(muteRms).toBeLessThan(0.001);

    const syncPlan: SegmentPlan = {
      version: 1,
      source: makeSource(),
      segments: [
        { id: "loud-first", role: "cold_open", startFrame: 60, endFrame: 90, speed: 1, motion: "repeat", audio: "source" },
        { id: "quiet-second", role: "body", startFrame: 0, endFrame: 30, speed: 1, motion: "repeat", audio: "source" },
      ],
    };
    const syncOut = join(dir, "sync-out.mp4");
    await renderSegmentPlan(syncPlan, syncClip, syncOut);
    const pcm = await rawAudio(syncOut);
    const onset = pcm.findIndex((value) => Math.abs(value) > 0.05) / SAMPLE_RATE;
    expect(onset).toBeLessThanOrEqual(1 / FPS);
    let lastLoud = pcm.length - 1;
    while (lastLoud > 0 && Math.abs(pcm[lastLoud]!) <= 0.05) lastLoud -= 1;
    expect(Math.abs(lastLoud / SAMPLE_RATE - 1)).toBeLessThanOrEqual(1 / FPS);
  }, testBudget(90_000));

  it("keeps silent sources silent, preserves 30000/1001 fps, and handles VFR sources", async () => {
    const silentPlan: SegmentPlan = {
      version: 1,
      source: makeSource({ hasAudio: false }),
      segments: [{ id: "only", role: "body", startFrame: 0, endFrame: 60, speed: 1, motion: "repeat", audio: "source" }],
    };
    const silentOut = join(dir, "silent-out.mp4");
    const silentResult = await renderSegmentPlan(silentPlan, silentClip, silentOut);
    expect(silentResult.probe.hasAudio).toBe(false);
    expect(silentResult.frames).toBe(60);

    const ntscProbe = await probeVideo(ntscClip);
    const ntscPlan: SegmentPlan = {
      version: 1,
      source: makeSource({ fps: ntscProbe.fps, frames: 90 }),
      segments: [
        { id: "n1", role: "cold_open", startFrame: 30, endFrame: 60, speed: 1, motion: "repeat", audio: "source" },
        { id: "n2", role: "body", startFrame: 0, endFrame: 60, speed: 1, motion: "repeat", audio: "source" },
      ],
    };
    const ntscOut = join(dir, "ntsc-out.mp4");
    const ntscResult = await renderSegmentPlan(ntscPlan, ntscClip, ntscOut);
    expect(ntscResult.frames).toBe(90);
    expect(ntscResult.probe.fps).toBeCloseTo(30000 / 1001, 2);

    const vfrProbe = await probeVideo(vfrClip);
    expect(isVariableFrameRate(vfrProbe)).toBe(true);
    const vfrFrames = Math.round(vfrProbe.videoDuration * vfrProbe.fps);
    const vfrPlan: SegmentPlan = {
      version: 1,
      source: makeSource({ fps: vfrProbe.fps, frames: vfrFrames, hasAudio: false }),
      segments: [{ id: "v1", role: "body", startFrame: 30, endFrame: 90, speed: 1, motion: "repeat", audio: "mute" }],
    };
    const vfrOut = join(dir, "vfr-out.mp4");
    const vfrResult = await renderSegmentPlan(vfrPlan, vfrClip, vfrOut);
    expect(vfrResult.frames).toBe(60);
  }, testBudget(90_000));

  it("reports both numbers on validation failures and leaves no output file on abort", async () => {
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource({ hasAudio: false }),
      segments: [{ id: "half", role: "body", startFrame: 0, endFrame: 60, speed: 1, motion: "repeat", audio: "mute" }],
    };
    const out = join(dir, "valid-check.mp4");
    await renderSegmentPlan(plan, silentClip, out);
    await expect(validateSegmentOutput({
      ...plan,
      segments: [{ id: "longer", role: "body", startFrame: 0, endFrame: 90, speed: 1, motion: "repeat", audio: "mute" }],
    }, out)).rejects.toThrow("Auto-edit output has 60 frames; the plan expects 90");
    await expect(validateSegmentOutput({
      ...plan,
      source: { ...plan.source, width: 640 },
    }, out)).rejects.toThrow("Auto-edit output is 320x180; the plan expects 640x180");

    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    const abortedOut = join(dir, "aborted.mp4");
    await expect(renderSegmentPlan(plan, silentClip, abortedOut, controller.signal)).rejects.toThrow("user cancelled");
    await expect(access(abortedOut)).rejects.toThrow();

    const midController = new AbortController();
    const slowPlan: SegmentPlan = {
      version: 1,
      source: makeSource({ hasAudio: false }),
      segments: [{ id: "slow-abort", role: "crash", startFrame: 0, endFrame: 120, speed: 0.25, motion: "flow", audio: "mute" }],
    };
    const midOut = join(dir, "aborted-mid.mp4");
    const timer = setTimeout(() => midController.abort(new Error("stopped mid-encode")), 50);
    try {
      await expect(renderSegmentPlan(slowPlan, silentClip, midOut, midController.signal)).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    await expect(access(midOut)).rejects.toThrow();
  }, testBudget(60_000));
});
