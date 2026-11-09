import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { AUDIO_OPTS, probeVideo, runFfmpeg, type ProbeResult } from "./ffmpeg.js";

const BYTES_PER_MB = 1024 * 1024;
const FILL_RATIOS = [0.92, 0.75] as const;
const AUDIO_KBPS = 192;
const MIN_VIDEO_KBPS = 1500;
const RATE_BUFFER_SECONDS = 1;

export interface FittedVideo {
  data: Uint8Array;
  filename: string;
}

function megabytes(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1);
}

function videoKbps(probe: ProbeResult, budgetBytes: number): number {
  const totalKbps = (budgetBytes * 8) / 1000 / (probe.duration + RATE_BUFFER_SECONDS);
  return Math.floor(totalKbps - (probe.hasAudio ? AUDIO_KBPS : 0));
}

function encodeArgs(sourcePath: string, outputPath: string, kbps: number, hasAudio: boolean): string[] {
  return [
    "-y", "-i", sourcePath,
    "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0"] : []),
    "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * RATE_BUFFER_SECONDS}k`,
    ...(hasAudio ? AUDIO_OPTS : ["-an"]),
    "-movflags", "+faststart",
    outputPath,
  ];
}

function tooLongToFit(sourceBytes: number, maxBytes: number, probe: ProbeResult): Error {
  return new Error(
    `The source video is ${megabytes(sourceBytes)} MB and ${probe.duration.toFixed(1)} s long. This model accepts source videos up to ${megabytes(maxBytes)} MB, and a clip this long cannot be re-encoded under that at usable quality. Trim it and try again.`,
  );
}

async function encodeWithinBudget(scratch: string, sourcePath: string, probe: ProbeResult, budgetBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const outputPath = join(scratch, "fitted.mp4");
  await runFfmpeg(encodeArgs(sourcePath, outputPath, videoKbps(probe, budgetBytes), probe.hasAudio), { signal });
  return readFile(outputPath);
}

async function fitSourceFile(scratch: string, sourcePath: string, sourceBytes: number, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const probe = await probeVideo(sourcePath, { signal });
  if (videoKbps(probe, maxBytes * FILL_RATIOS[0]) < MIN_VIDEO_KBPS) throw tooLongToFit(sourceBytes, maxBytes, probe);
  for (const fill of FILL_RATIOS) {
    const fitted = await encodeWithinBudget(scratch, sourcePath, probe, maxBytes * fill, signal);
    if (fitted.byteLength <= maxBytes) return fitted;
  }
  throw new Error(`The source video is ${megabytes(sourceBytes)} MB and could not be re-encoded under the ${megabytes(maxBytes)} MB this model accepts.`);
}

export async function fitVideoUnderByteCap(data: Uint8Array, filename: string, maxBytes: number, signal?: AbortSignal): Promise<FittedVideo> {
  if (data.byteLength <= maxBytes) return { data, filename };
  const scratch = await mkdtemp(join(tmpdir(), "videobook-video-fit-"));
  try {
    const sourcePath = join(scratch, `source${extname(filename)}`);
    await writeFile(sourcePath, data);
    const fitted = await fitSourceFile(scratch, sourcePath, data.byteLength, maxBytes, signal);
    return { data: new Uint8Array(fitted), filename: `${filename.slice(0, filename.length - extname(filename).length)}.mp4` };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
