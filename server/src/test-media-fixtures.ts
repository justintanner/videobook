import { createHash } from "node:crypto";
import { copyFile, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG } from "./ffmpeg.js";

const execFileAsync = promisify(execFile);

export type CachedVideoSource = "testsrc" | "color";

export interface CachedVideoSpec {
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  source: CachedVideoSource;
  color?: string;
  audio: false | { frequency: number };
}

export function mediaFixtureCacheDir(): string {
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
      audio: spec.audio,
    }))
    .digest("hex")
    .slice(0, 24);
}

function videoArgs(spec: CachedVideoSpec, outputPath: string): string[] {
  const videoInput = spec.source === "color"
    ? `color=c=${spec.color ?? "red"}:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${spec.durationSec}`
    : `testsrc=duration=${spec.durationSec}:size=${spec.width}x${spec.height}:rate=${spec.fps}`;
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
  await execFileAsync(FFMPEG, videoArgs(spec, tmp));
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
    width: 320,
    height: 240,
    durationSec,
    fps: 10,
    source: "testsrc",
    audio: { frequency: 440 },
  }),
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
    width: 320,
    height: 240,
    durationSec,
    fps: 30,
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
