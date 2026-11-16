import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CaptionMediaSource } from "../captions/source.js";
import { AUDIO_OPTS, FFMPEG, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { withCleanupInpainter } from "./inpaint.js";
import { cleanupPixelBox, type CleanupMethod, type CleanupRegion } from "./model.js";

export type CleanupProgress = { completedFrames: number; totalFrames: number; elapsedSeconds: number };

export type CleanupRender = {
  source: CaptionMediaSource;
  outputPath: string;
  regions: CleanupRegion[];
  method: CleanupMethod;
  signal: AbortSignal;
  onProgress?: (progress: CleanupProgress) => void;
};

function dimensions(source: CaptionMediaSource) {
  return { width: Math.max(2, Math.round(source.width / 2) * 2), height: Math.max(2, Math.round(source.height / 2) * 2) };
}

function sourceFilter(source: CaptionMediaSource): string {
  const { width, height } = dimensions(source);
  return `scale=${width}:${height},setsar=1,setpts=PTS-STARTPTS,fps=${source.fps}`;
}

async function audioArgs(input: CleanupRender, inputIndex: number): Promise<string[]> {
  if (!input.source.hasAudio) return ["-an"];
  const probe = await probeVideo(input.source.path, { signal: input.signal });
  const copy = ["aac", "mp3", "alac"].includes(probe.audioCodec ?? "");
  return ["-map", `${inputIndex}:a:0`, ...(copy ? ["-c:a", "copy"] : AUDIO_OPTS)];
}

function outputArgs(input: CleanupRender): string[] {
  return [...H264_MEDIUM, "-threads", "2", "-r", String(input.source.fps), "-t", String(input.source.durationSeconds), "-movflags", "+faststart", input.outputPath];
}

async function fill(input: CleanupRender): Promise<void> {
  const { width, height } = dimensions(input.source);
  const filters = input.regions.map((region) => {
    const box = cleanupPixelBox(region, width, height);
    return `delogo=x=${box.left + 2}:y=${box.top + 2}:w=${box.width}:h=${box.height}:enable='gte(t,${region.start})*lt(t,${region.end})'`;
  });
  const filter = [sourceFilter(input.source), "pad=iw+4:ih+4:2:2", ...filters, `crop=${width}:${height}:2:2`].join(",");
  await runFfmpeg(["-y", "-i", input.source.path, "-vf", filter, "-map", "0:v:0", ...await audioArgs(input, 0), ...outputArgs(input)], { signal: input.signal });
}

function mediaProcess(args: string[], signal: AbortSignal): { child: ChildProcessWithoutNullStreams; finished: Promise<Error | null> } {
  const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { signal, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
  child.stdin.on("error", () => {});
  const finished = new Promise<Error | null>((resolve) => {
    let error: Error | null = null;
    child.on("error", (cause) => { error = cause; });
    child.on("close", (code) => resolve(error ?? (code === 0 ? null : new Error(`Video removal process failed: ${stderr || `exit ${code}`}`))));
  });
  return { child, finished };
}

async function inpaint(input: CleanupRender): Promise<void> {
  const { width, height } = dimensions(input.source);
  const sound = await audioArgs(input, 1);
  const started = Date.now();
  const totalFrames = Math.round(input.source.durationSeconds * input.source.fps);
  input.onProgress?.({ completedFrames: 0, totalFrames, elapsedSeconds: 0 });
  await withCleanupInpainter(async (paint) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const decoder = mediaProcess(["-i", input.source.path, "-vf", sourceFilter(input.source), "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], signal);
    const encoder = mediaProcess(["-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-framerate", String(input.source.fps), "-i", "pipe:0", "-i", input.source.path, "-map", "0:v:0", ...sound, ...outputArgs(input)], signal);
    encoder.child.stdout.resume();
    const frameBytes = width * height * 3;
    let pending = Buffer.alloc(0);
    let index = 0;
    try {
      for await (const chunk of decoder.child.stdout) {
        input.signal.throwIfAborted();
        pending = Buffer.concat([pending, chunk as Buffer]);
        while (pending.length >= frameBytes) {
          signal.throwIfAborted();
          const frame = pending.subarray(0, frameBytes);
          const time = index / input.source.fps;
          const active = input.regions.filter((r) => time >= r.start && time < r.end);
          const cleaned = active.length ? await paint(frame, width, height, active) : frame;
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => encoder.child.stdin.write(cleaned, (error) => error ? reject(error) : resolve()));
          pending = pending.subarray(frameBytes);
          index++;
          input.onProgress?.({ completedFrames: index, totalFrames, elapsedSeconds: (Date.now() - started) / 1000 });
        }
      }
      const decodeError = await decoder.finished;
      if (decodeError) throw decodeError;
      if (pending.length || !index) throw new Error("Video decoding ended with an incomplete frame.");
      encoder.child.stdin.end();
      const encodeError = await encoder.finished;
      if (encodeError) throw encodeError;
    } finally {
      controller.abort();
      await Promise.all([decoder.finished, encoder.finished]);
    }
  });
}

export async function renderCleanup(input: CleanupRender): Promise<void> {
  if (input.method === "fill") await fill(input);
  else await inpaint(input);
  input.signal.throwIfAborted();
  const actual = await probeVideo(input.outputPath, { signal: input.signal });
  const expected = dimensions(input.source);
  if (actual.width !== expected.width || actual.height !== expected.height
    || Math.abs(actual.videoDuration - input.source.durationSeconds) > 1 / input.source.fps + 0.002
    || Math.abs(actual.fps - input.source.fps) > 0.01
    || actual.hasAudio !== input.source.hasAudio) throw new Error("The cleaned video did not preserve the source dimensions, duration, frame rate or audio.");
}
