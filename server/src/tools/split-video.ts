import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { join } from "node:path";
import { z } from "zod";
import { probeVideo } from "../ffmpeg.js";
import type { CutVideoRangesResult } from "../jobs/cut-video-ranges.js";
import { addClipCells } from "../notebook-clip-cells.js";
import { queue } from "../queue.js";
import type { SceneCutOptions } from "../scene-cuts.js";
import { DEFAULT_MIN_SCENE_SECONDS, DEFAULT_SCENE_MIN_SCORE, selectSceneCuts } from "../scene-cuts.js";
import type { VideoRange } from "../video-cut-ranges.js";
import { cutPointPieces, durationCutPoints } from "../video-cut-ranges.js";
import { awaitScenes } from "./detect-scenes.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { toolError } from "./_shared.js";
import type { VideoCutSource } from "./video-source-reference.js";
import { resolveVideoCutSource } from "./video-source-reference.js";
import { parseVideoTimestamp, videoTimestampSchema } from "./video-time-input.js";

type SplitArgs = {
  asset_id: string;
  book_id: string;
  notebook_id?: string;
  cut_points?: Array<string | number>;
  durations?: number[];
  scenes?: boolean;
  min_score?: number;
  include_settles?: boolean;
  min_scene_seconds?: number;
  actor?: string;
};

async function probedDuration(engine: Engine, artifactId: string): Promise<number> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const video = findVideoFile(manifest.value.files);
  if (!video) throw new Error(`No video file found in asset ${artifactId}`);
  const probe = await probeVideo(join(manifest.value.path, video.name));
  return probe.videoDuration || probe.duration;
}

function requestedModes(args: SplitArgs): number {
  return [(args.cut_points?.length ?? 0) > 0, (args.durations?.length ?? 0) > 0, args.scenes === true]
    .filter(Boolean).length;
}

async function splitPieces(engine: Engine, args: SplitArgs, artifactId: string): Promise<VideoRange[]> {
  if (requestedModes(args) !== 1) throw new Error("Pass exactly one of cut_points, durations, or scenes: true");
  if (args.scenes) {
    const scenes = await awaitScenes(engine, artifactId, args.book_id);
    const options: SceneCutOptions = {
      minScore: args.min_score,
      includeSettles: args.include_settles,
      minSceneSeconds: args.min_scene_seconds,
    };
    const cuts = selectSceneCuts(scenes, options);
    if (cuts.length === 0) throw new Error("No scene cuts found; lower min_score or include settles");
    return cutPointPieces(cuts, scenes.durationSeconds);
  }
  const points = args.durations
    ? durationCutPoints(args.durations)
    : args.cut_points!.map((point, index) => parseVideoTimestamp(point, `cut_points[${index}]`)!);
  return cutPointPieces(points, await probedDuration(engine, artifactId));
}

function pieceLabel(index: number): string {
  return `Part ${String(index + 1).padStart(2, "0")}`;
}

async function splitToCells(engine: Engine, args: SplitArgs, source: VideoCutSource, pieces: VideoRange[]): Promise<ToolResult> {
  const placed = await addClipCells(engine, {
    bookId: args.book_id,
    document: source.notebook!.document,
    source: source.notebook!.cell,
    requests: pieces.map((piece, index) => ({ label: pieceLabel(index), keepRanges: [piece] })),
    actor: args.actor,
  });
  return jsonResult({
    source_asset_id: source.artifactId,
    source_address: placed.sourceAddress,
    pieces,
    cells: placed.cells.map((cell) => ({ cell_id: cell.cellId, address: cell.address })),
    job_id: placed.jobId,
    run_id: placed.runId,
    status: "queued",
  });
}

async function splitToAssets(engine: Engine, args: SplitArgs, artifactId: string, pieces: VideoRange[]): Promise<ToolResult> {
  const artifact = engine.artifacts.get(artifactId);
  const base = artifact.ok ? artifact.value.label ?? artifactId : artifactId;
  const jobId = `cut-video-ranges-${artifactId}-${Date.now()}`;
  const results = await queue.enqueueAndWait<CutVideoRangesResult>(jobId, {
    type: "cut_video_ranges",
    sourceAssetId: artifactId,
    outputs: pieces.map((piece, index) => ({ title: `${base} ${pieceLabel(index).toLowerCase()}`, keepRanges: [piece] })),
    bookId: args.book_id,
  });
  return jsonResult({
    source_asset_id: artifactId,
    pieces,
    output_asset_ids: results.map((result) => result.artifactId),
    job_id: jobId,
    status: "completed",
  });
}

function jsonResult(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function splitVideo(engine: Engine, args: SplitArgs): Promise<ToolResult> {
  const source = resolveVideoCutSource(engine, args.asset_id, args.notebook_id);
  const pieces = await splitPieces(engine, args, source.artifactId);
  return source.notebook
    ? await splitToCells(engine, args, source, pieces)
    : await splitToAssets(engine, args, source.artifactId, pieces);
}

export function splitVideoDef(engine: Engine): ToolDef {
  return {
    name: "split_video",
    description:
      "Split a video into consecutive clips while keeping the source: at cut_points (e.g. [15] for 'first 15s and the rest'), into chunks of the given durations plus the leftover, or at detected scenes (scenes: true). A notebook source gets one new cell per clip below it; any other video gets new assets.",
    annotations: {
      title: "Split video into clips",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    schema: {
      asset_id: z.string().describe("Source video artifact id or notebook reference such as @a1"),
      book_id: z.string().describe("Book UUID"),
      notebook_id: z.string().uuid().optional().describe("Notebook UUID when asset_id is a grid reference and the book has multiple matching notebooks"),
      cut_points: z.array(videoTimestampSchema).min(1).max(200).optional().describe("Times to cut at, in seconds or timestamps such as 15s or 1:30"),
      durations: z.array(z.number().positive()).min(1).max(200).optional().describe("Chunk lengths in seconds; whatever remains becomes the last clip"),
      scenes: z.boolean().optional().describe("Cut at detected camera cuts (reuses a cached detect_scenes result)"),
      min_score: z.number().min(0).max(100).optional().describe(`With scenes: minimum camera-cut score (default ${DEFAULT_SCENE_MIN_SCORE})`),
      include_settles: z.boolean().optional().describe("With scenes: also split where motion settles inside a shot"),
      min_scene_seconds: z.number().min(0.02).optional().describe(`With scenes: shortest scene to keep (default ${DEFAULT_MIN_SCENE_SECONDS}s)`),
      actor: z.string().min(1).optional(),
    },
    handler: async (args) => {
      try {
        return await splitVideo(engine, args as SplitArgs);
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}
