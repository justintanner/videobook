import { findVideoFile, type Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import { addClipCells } from "../notebook-clip-cells.js";
import type { CutVideoRangesResult } from "../jobs/cut-video-ranges.js";
import type { TrimRequest, VideoRange } from "../video-cut-ranges.js";
import { cutRangesOutside, formatRangeSeconds, trimKeepRanges } from "../video-cut-ranges.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { toolError } from "./_shared.js";
import type { VideoCutSource } from "./video-source-reference.js";
import { resolveVideoCutSource } from "./video-source-reference.js";
import { parseVideoTimestamp, videoTimestampSchema } from "./video-time-input.js";
import { waitForAssetReadyDef } from "./wait-for-asset-ready.js";

type TrimOutput = "new" | "in_place";

type TrimArgs = {
  asset_id: string;
  book_id: string;
  notebook_id?: string;
  trim_start?: string | number;
  trim_end?: string | number;
  cut_start?: string | number;
  cut_end?: string | number;
  cuts?: Array<{ start: string | number; end: string | number }>;
  head_seconds?: number;
  tail_seconds?: number;
  output?: TrimOutput;
  name?: string;
  actor?: string;
};

type SourceFile = { assetDir: string; videoPath: string; durationSeconds: number; hasAudio: boolean };

function requiredTimestamp(value: string | number, field: string): number {
  return parseVideoTimestamp(value, field)!;
}

function singleCut(args: TrimArgs): VideoRange[] {
  if (args.cut_start === undefined && args.cut_end === undefined) return [];
  if (args.cut_start === undefined || args.cut_end === undefined) {
    throw new Error("Both cut_start and cut_end are required to remove a section");
  }
  return [{
    startSeconds: requiredTimestamp(args.cut_start, "cut_start"),
    endSeconds: requiredTimestamp(args.cut_end, "cut_end"),
  }];
}

function listedCuts(args: TrimArgs): VideoRange[] {
  return (args.cuts ?? []).map((cut, index) => ({
    startSeconds: requiredTimestamp(cut.start, `cuts[${index}].start`),
    endSeconds: requiredTimestamp(cut.end, `cuts[${index}].end`),
  }));
}

function trimRequest(args: TrimArgs): TrimRequest {
  const cuts = [...singleCut(args), ...listedCuts(args)];
  return {
    keepStart: parseVideoTimestamp(args.trim_start, "trim_start"),
    keepEnd: parseVideoTimestamp(args.trim_end, "trim_end"),
    ...(cuts.length === 0 ? {} : { cuts }),
    headSeconds: args.head_seconds,
    tailSeconds: args.tail_seconds,
  };
}

async function sourceFile(engine: Engine, artifactId: string): Promise<SourceFile> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const video = findVideoFile(manifest.value.files);
  if (!video) throw new Error(`No video file found in asset ${artifactId}`);
  const videoPath = join(manifest.value.path, video.name);
  const probe = await probeVideo(videoPath);
  return {
    assetDir: manifest.value.path,
    videoPath,
    durationSeconds: probe.videoDuration || probe.duration,
    hasAudio: probe.hasAudio,
  };
}

function inPlaceJob(artifactId: string, bookId: string, file: SourceFile, keeps: VideoRange[]): Record<string, unknown> {
  if (keeps.length === 1) {
    return {
      type: "trim_video",
      inputPath: file.videoPath,
      outputPath: join(file.assetDir, "original_trimmed.mp4"),
      mode: "keep",
      trimStart: keeps[0]!.startSeconds,
      trimEnd: keeps[0]!.endSeconds,
      assetId: artifactId,
      assetDir: file.assetDir,
      bookId,
      commitParams: { mode: "keep", trim_start: keeps[0]!.startSeconds, trim_end: keeps[0]!.endSeconds },
    };
  }
  return {
    type: "apply_cuts",
    inputPath: file.videoPath,
    outputPath: join(file.assetDir, "original_cuts.mp4"),
    cuts: cutRangesOutside(keeps, file.durationSeconds).map((cut) => ({ cut_start: cut.startSeconds, cut_end: cut.endSeconds })),
    duration: file.durationSeconds,
    hasAudio: file.hasAudio,
    assetId: artifactId,
    assetDir: file.assetDir,
    bookId,
  };
}

async function waitUntilReady(engine: Engine, artifactId: string, bookId: string): Promise<void> {
  const readiness = await waitForAssetReadyDef(engine).handler({
    asset_id: artifactId,
    book_id: bookId,
    timeout_seconds: 300,
  });
  if (!readiness.isError) return;
  const text = readiness.content.find((entry) => entry.type === "text")?.text ?? "";
  try {
    const parsed = JSON.parse(text) as { error?: unknown; status?: unknown };
    throw new Error(typeof parsed.error === "string" ? parsed.error : `Post-trim processing ${String(parsed.status ?? "failed")}`);
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error(text || "Post-trim processing failed");
    throw cause;
  }
}

async function trimInPlace(engine: Engine, args: TrimArgs, artifactId: string, file: SourceFile, keeps: VideoRange[]): Promise<ToolResult> {
  const jobId = `trim-${artifactId}-${Date.now()}`;
  await queue.enqueueAndWait(jobId, inPlaceJob(artifactId, args.book_id, file, keeps));
  await waitUntilReady(engine, artifactId, args.book_id);
  return jsonResult({ asset_id: artifactId, output: "in_place", keep_ranges: keeps, job_id: jobId, status: "completed" });
}

function trimLabel(keeps: readonly VideoRange[]): string {
  return keeps.length === 1 ? `Trim ${formatRangeSeconds(keeps[0]!)}` : `Trim · ${keeps.length} ranges`;
}

async function trimToNewCell(engine: Engine, args: TrimArgs, source: VideoCutSource, keeps: VideoRange[]): Promise<ToolResult> {
  const placed = await addClipCells(engine, {
    bookId: args.book_id,
    document: source.notebook!.document,
    source: source.notebook!.cell,
    requests: [{ label: args.name ?? trimLabel(keeps), keepRanges: keeps }],
    actor: args.actor,
  });
  const cell = placed.cells[0]!;
  return jsonResult({
    source_asset_id: source.artifactId,
    source_address: placed.sourceAddress,
    output: "new",
    cell_id: cell.cellId,
    address: cell.address,
    keep_ranges: keeps,
    job_id: placed.jobId,
    run_id: placed.runId,
    status: "queued",
  });
}

async function trimToNewAsset(engine: Engine, args: TrimArgs, artifactId: string, keeps: VideoRange[]): Promise<ToolResult> {
  const label = engine.artifacts.get(artifactId);
  const base = label.ok ? label.value.label ?? artifactId : artifactId;
  const jobId = `cut-video-ranges-${artifactId}-${Date.now()}`;
  const [result] = await queue.enqueueAndWait<CutVideoRangesResult>(jobId, {
    type: "cut_video_ranges",
    sourceAssetId: artifactId,
    outputs: [{ title: args.name ?? `${base} ${trimLabel(keeps).toLowerCase()}`, keepRanges: keeps }],
    bookId: args.book_id,
  });
  return jsonResult({
    source_asset_id: artifactId,
    output: "new",
    output_asset_id: result!.artifactId,
    duration: result!.durationSeconds,
    keep_ranges: keeps,
    job_id: jobId,
    status: "completed",
  });
}

function jsonResult(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function trimVideo(engine: Engine, args: TrimArgs): Promise<ToolResult> {
  const source = resolveVideoCutSource(engine, args.asset_id, args.notebook_id);
  const request = trimRequest(args);
  const file = await sourceFile(engine, source.artifactId);
  const keeps = trimKeepRanges(request, file.durationSeconds);
  if ((args.output ?? "in_place") === "in_place") return await trimInPlace(engine, args, source.artifactId, file, keeps);
  if (source.notebook) return await trimToNewCell(engine, args, source, keeps);
  return await trimToNewAsset(engine, args, source.artifactId, keeps);
}

export function trimVideoDef(engine: Engine): ToolDef {
  return {
    name: "trim_video",
    description:
      "Trim a video: keep a range (trim_start/trim_end), remove ranges (cut_start/cut_end or cuts), or shave seconds off the ends (head_seconds/tail_seconds, e.g. 'remove the last 2s' is tail_seconds 2). output in_place rewrites the source; output new keeps the source and writes the result to a new cell below a notebook source (or a new asset). Times accept seconds, 15s or 1:30.",
    annotations: {
      title: "Trim video",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    schema: {
      asset_id: z.string().describe("Source video asset ID or notebook reference such as @a1"),
      book_id: z.string().describe("Book id"),
      notebook_id: z.string().uuid().optional().describe("Notebook UUID when asset_id is a grid reference and the book has multiple matching notebooks"),
      trim_start: videoTimestampSchema.optional().describe("Start of range to keep"),
      trim_end: videoTimestampSchema.optional().describe("End of range to keep"),
      cut_start: videoTimestampSchema.optional().describe("Start of a section to remove"),
      cut_end: videoTimestampSchema.optional().describe("End of a section to remove"),
      cuts: z.array(z.object({ start: videoTimestampSchema, end: videoTimestampSchema })).min(1).max(200).optional()
        .describe("Several sections to remove, for example ranges from suggest_cuts"),
      head_seconds: z.number().min(0).optional().describe("Seconds to remove from the start"),
      tail_seconds: z.number().min(0).optional().describe("Seconds to remove from the end"),
      output: z.enum(["new", "in_place"]).optional().describe("in_place (default) edits the source; new keeps it and adds the trimmed clip"),
      name: z.string().min(1).optional().describe("Label for the new cell or asset"),
      actor: z.string().min(1).optional(),
    },
    handler: async (args) => {
      try {
        return await trimVideo(engine, args as TrimArgs);
      } catch (cause) {
        return toolError(`Trim failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  };
}
