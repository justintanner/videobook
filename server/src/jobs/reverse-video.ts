import type { ClipfirstFs } from "clipfirst-fs";
import { unlink, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { registerJobHandler } from "../queue.js";

interface FFmpeggyConstructorOpts {
  input: string;
  output: string;
  outputOptions: string[];
  overwriteExisting: boolean;
}
interface FFmpeggyInstance {
  run(): Promise<unknown>;
  done(): Promise<unknown>;
}
interface FFmpeggyClass {
  new (opts: FFmpeggyConstructorOpts): FFmpeggyInstance;
  DefaultConfig: { ffmpegBin: string; ffprobeBin: string };
}

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const FFPROBE: string = require("ffprobe-static").path;

let _FFmpeggy: FFmpeggyClass | null = null;
function getFFmpeggy(): FFmpeggyClass {
  if (!_FFmpeggy) {
    const mod: { FFmpeggy: FFmpeggyClass } = require("ffmpeggy");
    _FFmpeggy = mod.FFmpeggy;
    _FFmpeggy.DefaultConfig.ffmpegBin = FFMPEG;
    _FFmpeggy.DefaultConfig.ffprobeBin = FFPROBE;
  }
  return _FFmpeggy;
}

const LOCK_DURATION_MS = 300_000;
const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level:v", "4.0"];
const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k"];

function buildReverseOutputOptions(hasAudio: boolean): string[] {
  const opts = ["-vf", "reverse"];
  if (hasAudio) {
    opts.push("-af", "areverse");
  } else {
    opts.push("-an");
  }
  opts.push(...H264_MEDIUM, ...AUDIO_OPTS);
  return opts;
}

type ReverseVideoPayload = {
  type: "reverse_video";
  inputPath: string;
  outputPath: string;
  hasAudio: boolean;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerReverseVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("reverse_video", async (payload) => {
    const {
      inputPath, outputPath, hasAudio,
      assetId, assetDir, projectSlug,
    } = payload as ReverseVideoPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      const outputOptions = buildReverseOutputOptions(hasAudio);
      const FFmpeggy = getFFmpeggy();
      const ff = new FFmpeggy({
        input: inputPath,
        output: outputPath,
        outputOptions,
        overwriteExisting: true,
      });

      await ff.run();
      await ff.done();

      await unlink(inputPath);
      await rename(outputPath, inputPath);

      await fs.commitOperation("reverse", assetId, {}, projectSlug);

      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
