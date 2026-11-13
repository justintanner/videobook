import { rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import sharp from "sharp";
import { displayDimensions } from "../captions/geometry.js";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import type { ProbeResult } from "../ffmpeg.js";
import type { GraphicsTransitionFrames } from "./render-stills.js";
import type { ResolvedGraphicsTiming } from "./timing.js";

export type BurnFades = { fadeIn: number; fadeOut: number };

type GraphicsBurnStill = { path: string; timing: ResolvedGraphicsTiming; transitions?: GraphicsTransitionFrames[] };
type GraphicsBurnInput = { videoPath: string; outputPath: string; stills: readonly GraphicsBurnStill[]; probe: ProbeResult; signal: AbortSignal };
type Frame = { width: number; height: number };
type Box = { left: number; top: number; width: number; height: number };
type PlacedStill = { path: string; left: number; top: number; start?: number; end?: number; fades: BurnFades; sequenceFps?: number; exclusiveEnd?: boolean };

const LOOP_MARGIN_SECONDS = 0.25;
const CLIP_END_TOLERANCE_SECONDS = 0.001;
const DURATION_TOLERANCE_SECONDS = 0.5;

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function burnWatermarkEnable(startSeconds?: number, endSeconds?: number): string {
  if (startSeconds === undefined && endSeconds === undefined) return "";
  const start = startSeconds ?? 0;
  return endSeconds === undefined
    ? `:enable='gte(t,${start})'`
    : `:enable='between(t,${start},${endSeconds})'`;
}

function burnWatermarkFadeFilters(fades: BurnFades, startSeconds: number | undefined, endSeconds: number | undefined): string {
  const parts: string[] = [];
  if (fades.fadeIn > 0) parts.push(`fade=t=in:st=${startSeconds ?? 0}:d=${fades.fadeIn}:alpha=1`);
  if (fades.fadeOut > 0 && endSeconds !== undefined) {
    parts.push(`fade=t=out:st=${roundSeconds(endSeconds - fades.fadeOut)}:d=${fades.fadeOut}:alpha=1`);
  }
  return parts.map((part) => `,${part}`).join("");
}

export function burnWatermarkLoopSeconds(
  fades: BurnFades,
  startSeconds: number | undefined,
  endSeconds: number | undefined,
  durationSeconds: number,
): number | null {
  if (fades.fadeIn === 0 && fades.fadeOut === 0) return null;
  const settledAt = fades.fadeOut > 0 && endSeconds !== undefined ? endSeconds : (startSeconds ?? 0) + fades.fadeIn;
  return roundSeconds(Math.min(durationSeconds, settledAt + LOOP_MARGIN_SECONDS));
}

export function burnWatermarkInputArgs(path: string, loopSeconds: number | null, frameRate: string): string[] {
  return loopSeconds === null
    ? ["-i", path]
    : ["-loop", "1", "-framerate", frameRate, "-t", String(loopSeconds), "-i", path];
}

function burnWatermarkFrameRate(probe: ProbeResult): string {
  const nominal = probe.videoStream?.video?.nominalFrameRate;
  if (nominal && nominal.numerator > 0 && nominal.denominator > 0) return `${nominal.numerator}/${nominal.denominator}`;
  return String(roundSeconds(probe.fps > 0 ? probe.fps : 30));
}

export function graphicsBurnFrame(probe: ProbeResult): Frame {
  const video = probe.videoStream?.video;
  return video ? displayDimensions(video) : { width: probe.width, height: probe.height };
}

function squarePixels(probe: ProbeResult): boolean {
  const aspect = probe.videoStream?.video?.pixelAspect;
  return !aspect || aspect.numerator <= 0 || aspect.denominator <= 0 || aspect.numerator === aspect.denominator;
}

function lastOpaque(row: Uint8Array): number {
  for (let x = row.length - 1; x >= 0; x -= 1) {
    if (row[x] > 0) return x;
  }
  return -1;
}

function rowExtent(row: Uint8Array): [number, number] | null {
  const first = row.findIndex((alpha) => alpha > 0);
  return first < 0 ? null : [first, lastOpaque(row)];
}

async function opaqueBox(path: string, frame: Frame): Promise<Box | null> {
  const { data, info } = await sharp(path).ensureAlpha().extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
  if (info.width !== frame.width || info.height !== frame.height) {
    throw new Error(`A graphics still is ${info.width}x${info.height}, but the video is ${frame.width}x${frame.height}.`);
  }
  const box = { minX: info.width, maxX: -1, minY: info.height, maxY: -1 };
  for (let y = 0; y < info.height; y += 1) {
    const extent = rowExtent(data.subarray(y * info.width, (y + 1) * info.width));
    if (!extent) continue;
    box.minX = Math.min(box.minX, extent[0]);
    box.maxX = Math.max(box.maxX, extent[1]);
    box.minY = Math.min(box.minY, y);
    box.maxY = y;
  }
  return box.maxX < 0 ? null : { left: box.minX, top: box.minY, width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1 };
}

function croppedPath(path: string): string {
  return join(dirname(path), `${basename(path, extname(path))}-cropped.png`);
}

function windowEdges(timing: ResolvedGraphicsTiming, durationSeconds: number): { start?: number; end?: number } {
  return {
    ...(timing.start > 0 ? { start: timing.start } : {}),
    ...(timing.end < durationSeconds - CLIP_END_TOLERANCE_SECONDS ? { end: timing.end } : {}),
  };
}

async function placeStill(still: GraphicsBurnStill, frame: Frame, durationSeconds: number): Promise<PlacedStill | null> {
  const box = await opaqueBox(still.path, frame);
  if (!box) return null;
  const path = croppedPath(still.path);
  await sharp(still.path).extract(box).png().toFile(path);
  return { path, left: box.left, top: box.top, ...windowEdges(still.timing, durationSeconds), fades: { fadeIn: still.timing.fadeIn, fadeOut: still.timing.fadeOut } };
}

function unionBox(left: Box | null, right: Box | null): Box | null {
  if (!left) return right;
  if (!right) return left;
  const x = Math.min(left.left, right.left);
  const y = Math.min(left.top, right.top);
  return { left: x, top: y, width: Math.max(left.left + left.width, right.left + right.width) - x, height: Math.max(left.top + left.height, right.top + right.height) - y };
}

async function placeSequence(sequence: GraphicsTransitionFrames, frame: Frame): Promise<PlacedStill | null> {
  let box: Box | null = null;
  for (const path of sequence.paths) box = unionBox(box, await opaqueBox(path, frame));
  if (!box) return null;
  for (const path of sequence.paths) await sharp(path).extract(box).png().toFile(croppedPath(path));
  const path = croppedPath(sequence.paths[0]).replace(/000000-cropped\.png$/u, "%06d-cropped.png");
  return { path, left: box.left, top: box.top, start: sequence.start, end: sequence.end, fades: { fadeIn: 0, fadeOut: 0 }, sequenceFps: sequence.fps, exclusiveEnd: true };
}

async function placeGroup(still: GraphicsBurnStill, frame: Frame, duration: number): Promise<PlacedStill[]> {
  const placed = await placeStill(still, frame, duration);
  if (!still.transitions?.length) return placed ? [placed] : [];
  const fps = still.transitions[0].fps;
  const start = Math.ceil((still.timing.start + still.timing.fadeIn) * fps - 1e-7) / fps;
  const end = Math.ceil((still.timing.end - still.timing.fadeOut) * fps - 1e-7) / fps;
  const settled = placed && end > start ? [{ ...placed, start, end, fades: { fadeIn: 0, fadeOut: 0 }, exclusiveEnd: true }] : [];
  const transitions = await Promise.all(still.transitions.map((sequence) => placeSequence(sequence, frame)));
  return [...settled, ...transitions.filter((sequence): sequence is PlacedStill => sequence !== null)];
}

function stillInputArgs(still: PlacedStill, probe: ProbeResult): string[] {
  if (still.sequenceFps) return ["-f", "image2", "-framerate", String(still.sequenceFps), "-start_number", "0", "-i", still.path];
  const loopSeconds = burnWatermarkLoopSeconds(still.fades, still.start, still.end, probe.videoDuration);
  return burnWatermarkInputArgs(still.path, loopSeconds, burnWatermarkFrameRate(probe));
}

function baseFilter(probe: ProbeResult, frame: Frame): { filters: string[]; label: string } {
  if (squarePixels(probe)) return { filters: [], label: "0:v" };
  return { filters: [`[0:v]scale=${frame.width}:${frame.height},setsar=1[base]`], label: "base" };
}

export function burnFilter(stills: readonly PlacedStill[], probe: ProbeResult, frame: Frame): string {
  const base = baseFilter(probe, frame);
  const chains = stills.map((still, index) => `[${index + 1}:v]format=rgba${still.sequenceFps ? `,setpts=PTS-STARTPTS+${still.start}/TB` : burnWatermarkFadeFilters(still.fades, still.start, still.end)}[g${index + 1}]`);
  const overlays = stills.map((still, index) => {
    const input = index === 0 ? base.label : `v${index}`;
    const output = index === stills.length - 1 ? "vout" : `v${index + 1}`;
    const enable = still.exclusiveEnd ? `:enable='gte(t,${still.start})*lt(t,${still.end})'` : burnWatermarkEnable(still.start, still.end);
    return `[${input}][g${index + 1}]overlay=${still.left}:${still.top}:format=auto${enable}[${output}]`;
  });
  return [...base.filters, ...chains, ...overlays].join(";");
}

async function checkOutput(outputPath: string, probe: ProbeResult, frame: Frame, signal: AbortSignal): Promise<void> {
  const check = await probeVideo(outputPath, { signal });
  const size = graphicsBurnFrame(check);
  if (size.width !== frame.width || size.height !== frame.height || Math.abs(check.duration - probe.duration) > DURATION_TOLERANCE_SECONDS) {
    throw new Error(
      `The video with graphics looks wrong: ${size.width}x${size.height} ${check.duration.toFixed(2)}s`
      + ` from ${frame.width}x${frame.height} ${probe.duration.toFixed(2)}s`,
    );
  }
}

export async function burnGraphics(input: GraphicsBurnInput): Promise<void> {
  const frame = graphicsBurnFrame(input.probe);
  const placed = (await Promise.all(input.stills.map((still) => placeGroup(still, frame, input.probe.videoDuration)))).flat();
  if (placed.length === 0) throw new Error("These graphics have nothing to draw.");
  input.signal.throwIfAborted();
  try {
    await runFfmpeg([
      "-y",
      "-i", input.videoPath,
      ...placed.flatMap((still) => stillInputArgs(still, input.probe)),
      "-filter_complex", burnFilter(placed, input.probe, frame),
      "-map", "[vout]",
      "-map", "0:a?",
      ...H264_MEDIUM,
      "-pix_fmt", "yuv420p",
      ...AUDIO_OPTS,
      input.outputPath,
    ], { signal: input.signal });
    await checkOutput(input.outputPath, input.probe, frame, input.signal);
  } catch (error) {
    await rm(input.outputPath, { force: true });
    throw error;
  }
}
