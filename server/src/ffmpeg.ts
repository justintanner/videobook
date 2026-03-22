import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
export const FFMPEG: string = require("ffmpeg-static");
export const FFPROBE: string = require("ffprobe-static").path;

export const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-profile:v", "high", "-level:v", "4.0"];
export const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k"];

export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const videoStream = (data.streams as Array<Record<string, unknown>>)?.find(
    (s) => s.codec_type === "video",
  );
  const width = Number(videoStream?.width ?? 0);
  const height = Number(videoStream?.height ?? 0);
  const duration = Number(data.format?.duration ?? 0);

  let fps = 30;
  const rFrameRate = videoStream?.r_frame_rate;
  if (typeof rFrameRate === "string" && rFrameRate.includes("/")) {
    const [num, den] = rFrameRate.split("/").map(Number);
    if (den > 0) fps = num / den;
  }

  const hasAudio = (data.streams as Array<Record<string, unknown>>)?.some(
    (s) => s.codec_type === "audio",
  ) ?? false;

  return { width, height, duration, fps, hasAudio };
}

export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}

interface FFmpeggyProbeStream {
  codec_type: string;
}
interface FFmpeggyProbeFormat {
  duration: string;
}
interface FFmpeggyProbeResult {
  streams: FFmpeggyProbeStream[];
  format: FFmpeggyProbeFormat;
}
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
export interface FFmpeggyClass {
  new (opts: FFmpeggyConstructorOpts): FFmpeggyInstance;
  DefaultConfig: { ffmpegBin: string; ffprobeBin: string };
  probe(filePath: string): Promise<FFmpeggyProbeResult>;
}

let _FFmpeggy: FFmpeggyClass | null = null;

export async function extractWaveform(videoPath: string, barCount = 100): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(FFMPEG, [
      "-i", videoPath,
      "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
    ], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });
    const buf = stdout as unknown as Buffer;
    if (buf.length < 2) return [];
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    const samplesPerBin = Math.max(1, Math.floor(samples.length / barCount));
    const peaks: number[] = [];
    for (let b = 0; b < barCount; b++) {
      const start = b * samplesPerBin;
      const end = Math.min(start + samplesPerBin, samples.length);
      let sum = 0;
      for (let i = start; i < end; i++) {
        sum += samples[i] * samples[i];
      }
      peaks.push(Math.sqrt(sum / (end - start)));
    }
    const max = Math.max(...peaks, 1);
    return peaks.map((p) => p / max);
  } catch {
    return [];
  }
}

export async function getFFmpeggy(): Promise<FFmpeggyClass> {
  if (!_FFmpeggy) {
    const mod = await import("ffmpeggy") as { FFmpeggy: FFmpeggyClass };
    _FFmpeggy = mod.FFmpeggy;
    _FFmpeggy.DefaultConfig.ffmpegBin = FFMPEG;
    _FFmpeggy.DefaultConfig.ffprobeBin = FFPROBE;
  }
  return _FFmpeggy;
}
