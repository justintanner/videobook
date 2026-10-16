import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { probeVideo, type ProbeResult } from "../ffmpeg.js";
import { findVideoFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

type ResolvedSpliceClip = {
  assetId: string;
  filename: string;
  path: string;
  probe: ProbeResult;
};

type ResolveClipResult =
  | { ok: true; clip: ResolvedSpliceClip }
  | { ok: false; error: string };

function deriveSpliceName(assetIds: string[]): string {
  if (assetIds.length <= 2) return `splice-${assetIds[0]}-${assetIds[1]}`;
  return `splice-${assetIds[0]}-x${assetIds.length - 1}`;
}

function error(text: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

function uniqueAssetIds(ids: string[]): string[] | { error: string } {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed) return { error: "splice asset ids must be non-empty" };
    if (seen.has(trimmed)) {
      return { error: "splice asset ids must be unique" };
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

async function resolveSpliceClip(
  engine: Engine,
  assetId: string,
): Promise<ResolveClipResult> {
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "video") {
    return { ok: false, error: `Asset ${assetId} is not a video` };
  }
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) {
    return { ok: false, error: `${assetId}: ${manifest.error.message}` };
  }
  const video = findVideoFile(manifest.value.files);
  if (!video) return { ok: false, error: `No video file in asset ${assetId}` };
  const path = join(manifest.value.path, video.name);
  try {
    const probe = await probeVideo(path);
    return {
      ok: true,
      clip: { assetId, filename: video.name, path, probe },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `Failed to probe ${assetId}: ${message}` };
  }
}

export function spliceVideoDef(engine: Engine): ToolDef {
  return {
    name: "splice_video",
    description: "Join two or more videos in playback order into a new video. overlap 0 concatenates whole clips; a positive overlap cuts each boundary at the best-matching frame within that many seconds.",
    schema: {
      first_asset_id: z.string().describe("First video artifact id in playback order. The match point is searched within this video."),
      second_asset_id: z.string().describe("Second video artifact id in playback order. Its first frame is the search target against the preceding clip."),
      additional_asset_ids: z.array(z.string()).max(18).optional()
        .describe("Further video artifact ids in playback order after the second clip."),
      overlap: z.number().min(0).default(0)
        .describe("Possible overlap in seconds at each consecutive boundary. Use 0 to concatenate complete clips without trimming."),
      book_id: z.string().describe("Book UUID"),
    },
    handler: async (args) => {
      const {
        first_asset_id,
        second_asset_id,
        additional_asset_ids,
        overlap,
        book_id,
      } = args as {
        first_asset_id: string;
        second_asset_id: string;
        additional_asset_ids?: string[];
        overlap?: number;
        book_id: string;
      };
      const additional = Array.isArray(additional_asset_ids)
        ? additional_asset_ids
        : [];
      const ids = uniqueAssetIds([
        first_asset_id,
        second_asset_id,
        ...additional,
      ]);
      if (!Array.isArray(ids)) return error(ids.error);

      const resolved = await Promise.all(
        ids.map((assetId) => resolveSpliceClip(engine, assetId)),
      );
      const failed = resolved.find((result) => !result.ok);
      if (failed && !failed.ok) return error(failed.error);
      const clips = resolved.flatMap((result) => result.ok ? [result.clip] : []);
      const first = clips[0];
      if (!first) return error("splice_video requires at least two videos");

      const resolvedOverlap = typeof overlap === "number" ? overlap : 0;
      const spliceName = deriveSpliceName(ids);
      const assetResult = await engine.artifacts.create("video", spliceName);
      if (!assetResult.ok) {
        return error(`Failed to create splice asset: ${assetResult.error.message}`);
      }

      const { artifactId: assetId, path: assetDir } = assetResult.value;
      const outputPath = join(assetDir, "original.mp4");
      const jobId = `splice-${assetId}-${Date.now()}`;
      const second = clips[1]!;

      await queue.enqueue(jobId, {
        type: "splice_video",
        firstPath: first.path,
        secondPath: second.path,
        firstFilename: first.filename,
        secondFilename: second.filename,
        outputPath,
        firstAssetId: first.assetId,
        secondAssetId: second.assetId,
        assetId,
        assetDir,
        bookId: book_id,
        targetWidth: first.probe.width,
        targetHeight: first.probe.height,
        firstFps: first.probe.fps,
        firstDuration: first.probe.videoDuration,
        secondDuration: second.probe.videoDuration,
        firstHasAudio: first.probe.hasAudio,
        secondHasAudio: second.probe.hasAudio,
        overlap: resolvedOverlap,
        clips: clips.map((clip) => ({
          assetId: clip.assetId,
          filename: clip.filename,
          duration: clip.probe.videoDuration,
          hasAudio: clip.probe.hasAudio,
        })),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: assetId,
            first: first.assetId,
            second: second.assetId,
            first_asset_id: first.assetId,
            second_asset_id: second.assetId,
            ...(clips.length > 2
              ? { additional_asset_ids: clips.slice(2).map((clip) => clip.assetId) }
              : {}),
            overlap: resolvedOverlap,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
