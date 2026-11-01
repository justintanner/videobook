import { createHash } from "node:crypto";
import { copyFile, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFfmpeg } from "./ffmpeg.js";

type CachedVideoSource = "testsrc" | "color" | "cuts";

interface CachedVideoSpec {
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  source: CachedVideoSource;
  color?: string;
  shots?: Array<{ color: string; durationSec: number }>;
  audio: false | { frequency: number };
  keyframeInterval?: number;
}

function mediaFixtureCacheDir(): string {
  const root = process.env.VIDEOBOOK_TEST_ROOT ?? tmpdir();
  return join(root, "media-fixtures");
}

export function videoFixtureKey(spec: CachedVideoSpec): string {
  return createHash("sha256")
    .update(JSON.stringify({
      width: spec.width,
      height: spec.height,
      durationSec: spec.durationSec,
      fps: spec.fps,
      source: spec.source,
      color: spec.color ?? null,
      shots: spec.shots ?? null,
      audio: spec.audio,
      keyframeInterval: spec.keyframeInterval ?? null,
    }))
    .digest("hex")
    .slice(0, 24);
}

function shotsInput(spec: CachedVideoSpec): string {
  const shots = spec.shots ?? [];
  const sources = shots.map((shot, index) =>
    `color=c=${shot.color}:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${shot.durationSec}[s${index}]`);
  const labels = shots.map((_, index) => `[s${index}]`).join("");
  return `${sources.join(";")};${labels}concat=n=${shots.length}:v=1:a=0[out0]`;
}

function videoInputFor(spec: CachedVideoSpec): string {
  if (spec.source === "cuts") return shotsInput(spec);
  if (spec.source === "color") {
    return `color=c=${spec.color ?? "red"}:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${spec.durationSec}`;
  }
  return `testsrc=duration=${spec.durationSec}:size=${spec.width}x${spec.height}:rate=${spec.fps}`;
}

function videoArgs(spec: CachedVideoSpec, outputPath: string): string[] {
  const videoInput = videoInputFor(spec);
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", videoInput,
  ];
  if (spec.audio) {
    args.push(
      "-f", "lavfi",
      "-i", `sine=frequency=${spec.audio.frequency}:duration=${spec.durationSec}`,
    );
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
  );
  if (spec.keyframeInterval) {
    args.push(
      "-g", String(spec.keyframeInterval),
      "-keyint_min", String(spec.keyframeInterval),
      "-sc_threshold", "0",
    );
  }
  if (spec.audio) {
    args.push("-c:a", "aac", "-shortest");
  } else {
    args.push("-an");
  }
  args.push(outputPath);
  return args;
}

async function generateOnce(spec: CachedVideoSpec, dest: string): Promise<void> {
  const tmp = `${dest}.${process.pid}.tmp.mp4`;
  await runFfmpeg(videoArgs(spec, tmp));
  try {
    await copyFile(tmp, dest);
  } finally {
    await open(tmp, "r").then((handle) => handle.close()).catch(() => undefined);
    await import("node:fs/promises").then(({ unlink }) =>
      unlink(tmp).catch(() => undefined));
  }
}

export async function materializeVideoFixture(spec: CachedVideoSpec): Promise<string> {
  const dir = mediaFixtureCacheDir();
  await mkdir(dir, { recursive: true });
  const dest = join(dir, `${videoFixtureKey(spec)}.mp4`);
  try {
    const existing = await stat(dest);
    if (existing.isFile() && existing.size > 0) return dest;
  } catch {
    // generate below
  }
  const lockPath = `${dest}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        const existing = await stat(dest);
        if (existing.isFile() && existing.size > 0) return dest;
      } catch {
        // still generating
      }
    }
  }
  try {
    try {
      const existing = await stat(dest);
      if (existing.isFile() && existing.size > 0) return dest;
    } catch {
      await generateOnce(spec, dest);
    }
    return dest;
  } finally {
    await handle.close();
    await import("node:fs/promises").then(({ unlink }) =>
      unlink(lockPath).catch(() => undefined));
  }
}

export async function copyVideoFixture(
  spec: CachedVideoSpec,
  destPath: string,
): Promise<string> {
  const source = await materializeVideoFixture(spec);
  await copyFile(source, destPath);
  return destPath;
}

export const COMMON_VIDEO_FIXTURES = {
  evenSplit: (durationSec: number): CachedVideoSpec => ({
    width: 160,
    height: 120,
    durationSec,
    fps: 24,
    source: "color",
    color: "0x224466",
    audio: false,
    keyframeInterval: 24,
  }),
  sceneCuts: {
    width: 160,
    height: 120,
    durationSec: 6,
    fps: 24,
    source: "cuts",
    shots: [
      { color: "0x202020", durationSec: 2 },
      { color: "0xe0e0e0", durationSec: 2.5 },
      { color: "0x2060a0", durationSec: 1.5 },
    ],
    audio: { frequency: 440 },
  } satisfies CachedVideoSpec,
  cropHd: {
    width: 1920,
    height: 1080,
    durationSec: 2,
    fps: 10,
    source: "testsrc",
    audio: { frequency: 440 },
  } satisfies CachedVideoSpec,
  watermark: {
    width: 320,
    height: 240,
    durationSec: 1,
    fps: 12,
    source: "testsrc",
    audio: false,
  } satisfies CachedVideoSpec,
  extractAudio: {
    width: 320,
    height: 240,
    durationSec: 2,
    fps: 10,
    source: "testsrc",
    audio: { frequency: 440 },
  } satisfies CachedVideoSpec,
  extractAudioSilent: {
    width: 320,
    height: 240,
    durationSec: 2,
    fps: 10,
    source: "testsrc",
    audio: false,
  } satisfies CachedVideoSpec,
  padVideo: (durationSec: number, hasAudio: boolean): CachedVideoSpec => ({
    width: 160,
    height: 120,
    durationSec,
    fps: 10,
    source: "testsrc",
    audio: hasAudio ? { frequency: 440 } : false,
  }),
  timeline: (fps: number): CachedVideoSpec => ({
    width: 320,
    height: 240,
    durationSec: 1,
    fps,
    source: "testsrc",
    audio: { frequency: 440 },
  }),
} as const;
