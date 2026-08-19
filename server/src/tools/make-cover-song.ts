import { join } from "node:path";
import { findAudioFile, findVideoFile, type Artifact, type Engine } from "videobook-engine";
import { z } from "zod";
import { checkAceStepAvailability } from "../acestep/config.js";
import { probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { toolError } from "./_shared.js";
import type { ToolDef } from "./tool-def.js";

const MIN_SOURCE_DURATION_MS = 10_000;
const MAX_SOURCE_DURATION_MS = 240_000;

function coverSongLabel(source: Artifact): string {
  return `cover-song-${source.label?.trim() || source.artifactId}`;
}

export function makeCoverSongDef(engine: Engine): ToolDef {
  return {
    name: "make_cover_song",
    description: "Create a new drums-and-strings instrumental cover from 10 to 240 seconds of source audio in a video or audio asset, generated locally by the ACE-Step (acestep.cpp) runtime with source-audio conditioning. Rhythm and style matching are best-effort generative; output duration and sample count are exact.",
    schema: {
      book_id: z.string().describe("Book UUID"),
      asset_id: z.string().describe("Source video or audio artifact id"),
      direction: z.string().trim().min(1).max(500).optional().describe("Optional additional musical direction"),
    },
    handler: async (args) => {
      const availability = await checkAceStepAvailability();
      if (!availability.available) {
        return toolError(availability.reason);
      }

      const { asset_id, book_id, direction } = args as {
        asset_id: string;
        book_id: string;
        direction?: string;
      };
      const sourceAssetId = asset_id.replace(/^@/u, "");
      const sourceArtifact = engine.artifacts.get(sourceAssetId);
      if (!sourceArtifact.ok) return toolError(sourceArtifact.error.message);
      const sourceKind = sourceArtifact.value.kind;
      const isVideo = sourceKind === "video";
      const isAudio = sourceKind === "audio";
      if (!isVideo && !isAudio) {
        return toolError(`make_cover_song requires video or audio media; ${sourceAssetId} is ${sourceKind}`);
      }

      const manifest = await engine.files.manifest(sourceAssetId);
      if (!manifest.ok) return toolError(manifest.error.message);
      const sourceFile = isVideo
        ? findVideoFile(manifest.value.files)
        : findAudioFile(manifest.value.files, sourceKind);
      if (!sourceFile) return toolError(`No ${isVideo ? "video" : "audio"} file found in artifact ${sourceAssetId}`);

      let targetDurationMs: number;
      try {
        const probe = await probeVideo(join(manifest.value.path, sourceFile.name));
        if (isVideo && (probe.videoStream === null || probe.videoCodec === null)) {
          return toolError(`Video file ${sourceFile.name} has no video stream`);
        }
        if (!probe.hasAudio || probe.audioStream === null) {
          return toolError(`Media file ${sourceFile.name} has no audio stream`);
        }
        const sourceDuration = isVideo ? probe.videoDuration : probe.audioDuration;
        if (sourceDuration === null || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
          return toolError(`Could not determine a valid media duration for ${sourceAssetId}`);
        }
        targetDurationMs = Math.round(sourceDuration * 1000);
      } catch (error) {
        return toolError(`Failed to probe ${sourceAssetId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (targetDurationMs < MIN_SOURCE_DURATION_MS || targetDurationMs > MAX_SOURCE_DURATION_MS) {
        return toolError(
          `make_cover_song requires a media duration between 10.000s and 240.000s inclusive; got ${(targetDurationMs / 1000).toFixed(3)}s`,
        );
      }

      const created = await engine.artifacts.create(
        "audio",
        coverSongLabel(sourceArtifact.value),
      );
      if (!created.ok) return toolError(`Failed to create audio asset: ${created.error.message}`);

      const jobId = `make-cover-song-${created.value.artifactId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_acestep_cover",
        audAssetId: created.value.artifactId,
        sourceAssetId,
        sourceFilename: sourceFile.name,
        targetDurationMs,
        direction,
        bookId: book_id,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            audio_asset_id: created.value.artifactId,
            source_asset_id: sourceAssetId,
            source_kind: sourceKind,
            duration_seconds: targetDurationMs / 1000,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
