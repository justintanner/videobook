import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
export const FFMPEG: string = require("ffmpeg-static");
export const FFPROBE: string = require("ffprobe-static").path;

export const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level:v", "4.0"];
export const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k"];

export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  fps: number;
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

  return { width, height, duration, fps };
}

export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}
