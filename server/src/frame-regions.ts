import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { AnalysisComponentSpec } from "./analysis-components.js";
import { analysisComponentKey, readAnalysisComponent, writeAnalysisComponent } from "./analysis-components.js";
import { INTELLIGENCE_MODEL } from "./openai-intelligence.js";
import { detectOccupiedRegions } from "./vision-regions.js";

const FRAME_REGIONS: AnalysisComponentSpec = { component: "frame-regions", version: 1, jobType: "frame_regions" };

const BUCKET_SECONDS = 0.25;
const FRAMES_PER_REQUEST = 10;

const SYSTEM_PROMPT = `You are a precise video-layout analyst. Each attached image is a frame from a video that will carry overlays: captions, keyword titles, or a corner watermark.

For every frame, identify all occupied regions an overlay must not cover:
- every visible human face, including partial faces and faces on posters or screens
- every existing visible text block, subtitle, caption, title, logo, watermark, or graphic

Return one entry for every cue_id. Coordinates use a normalized image scale from 0 to 1000: x and y are the top-left corner, followed by width and height. Use tight boxes around the visible occupied content. Do not return boxes for bodies, clothing, scenery, instruments, microphones, or ordinary objects. Return an empty occupied_regions array only when none of the listed content is visible. Never omit, rename, or duplicate a cue_id.`;

const regionSchema = z.object({
  kind: z.enum(["face", "text", "graphic"]),
  confidence: z.number().min(0).max(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

export type FrameRegion = z.infer<typeof regionSchema>;

const valueSchema = z.object({
  frames: z.record(z.string(), z.object({ time: z.number().min(0), regions: z.array(regionSchema) })),
});

type StoredFrames = z.infer<typeof valueSchema>["frames"];

export interface FrameRegionsAt {
  time: number;
  regions: FrameRegion[];
}

export interface FrameRegionsRequest {
  engine: Engine;
  artifactId: string;
  mediaHash: string;
  times: readonly number[];
  frames: (times: readonly number[]) => Promise<Buffer[]>;
  apiKey: string | null;
  signal: AbortSignal;
}

function frameRegionsKey(mediaHash: string): string {
  return analysisComponentKey(FRAME_REGIONS, { sourceHash: mediaHash, options: { model: INTELLIGENCE_MODEL, bucketSeconds: BUCKET_SECONDS } });
}

function frameBucket(time: number): string {
  return (Math.round(Math.max(0, time) / BUCKET_SECONDS) * BUCKET_SECONDS).toFixed(2);
}

function storedFrames(engine: Engine, mediaHash: string): StoredFrames {
  return readAnalysisComponent(engine, FRAME_REGIONS, frameRegionsKey(mediaHash), valueSchema)?.value.frames ?? {};
}

export function missingFrameTimes(engine: Engine, mediaHash: string, times: readonly number[]): number[] {
  const stored = storedFrames(engine, mediaHash);
  const missing = new Map<string, number>();
  for (const time of times) {
    const bucket = frameBucket(time);
    if (!stored[bucket] && !missing.has(bucket)) missing.set(bucket, time);
  }
  return [...missing.values()];
}

function clampUnit(region: FrameRegion): FrameRegion {
  const unit = (value: number) => Math.max(0, Math.min(1, value));
  return { kind: region.kind, confidence: unit(region.confidence), x: unit(region.x), y: unit(region.y), width: unit(region.width), height: unit(region.height) };
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function detectFrames(times: readonly number[], buffers: readonly Buffer[], apiKey: string, signal: AbortSignal): Promise<FrameRegionsAt[]> {
  const detected: FrameRegionsAt[] = [];
  const frames = times.map((time, index) => ({ time, buffer: buffers[index] }));
  for (const batch of batches(frames, FRAMES_PER_REQUEST)) {
    const found = await detectOccupiedRegions(
      batch.map((frame, index) => ({ id: `f${index}`, label: `timestamp=${frame.time.toFixed(3)}s`, buffer: frame.buffer })),
      { apiKey, signal, instructions: SYSTEM_PROMPT, schemaName: "frame_regions", errorLabel: "Frame regions" },
    );
    batch.forEach((frame, index) => detected.push({ time: frame.time, regions: found.get(`f${index}`) ?? [] }));
  }
  return detected;
}

export function storeFrameRegions(engine: Engine, artifactId: string, mediaHash: string, frames: readonly FrameRegionsAt[]): void {
  const added = Object.fromEntries(frames.map((frame) => [frameBucket(frame.time), { time: frame.time, regions: frame.regions.map(clampUnit) }]));
  writeAnalysisComponent(engine, {
    component: FRAME_REGIONS.component,
    key: frameRegionsKey(mediaHash),
    artifactId,
    sourceHash: mediaHash,
    provenance: { analyzer: "frame-regions", version: FRAME_REGIONS.version, provider: "openai", model: INTELLIGENCE_MODEL, createdAt: new Date().toISOString() },
    value: { frames: { ...storedFrames(engine, mediaHash), ...added } },
  });
}

export async function frameRegionsAt(request: FrameRegionsRequest): Promise<FrameRegionsAt[]> {
  const missing = missingFrameTimes(request.engine, request.mediaHash, request.times);
  if (missing.length > 0) {
    if (!request.apiKey) throw new Error("Finding faces and on-screen text needs OPENAI_API_KEY.");
    const buffers = await request.frames(missing);
    request.signal.throwIfAborted();
    storeFrameRegions(request.engine, request.artifactId, request.mediaHash, await detectFrames(missing, buffers, request.apiKey, request.signal));
  }
  const stored = storedFrames(request.engine, request.mediaHash);
  return request.times.map((time) => ({ time, regions: stored[frameBucket(time)]?.regions ?? [] }));
}
