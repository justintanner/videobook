import { join } from "node:path";
import { findVideoFile, type Artifact, type Engine } from "videobook-engine";
import { z } from "zod";
import { getApiKey } from "../api-key.js";
import { probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { toolError } from "./_shared.js";
import type { ToolDef } from "./tool-def.js";

const MIN_SOURCE_DURATION_MS = 10_000;
const MAX_SOURCE_DURATION_MS = 30_000;

function replicatedSongLabel(source: Artifact): string {
  return `replicated-song-${source.label?.trim() || source.artifactId}`;
}

export function replicateSongDef(fs: Engine): ToolDef {
  return {
    name: "replicate_song",
    description: "Create a new drums-and-strings instrumental from a 10 to 30 second video soundtrack using ElevenLabs Music v2 reference conditioning. Rhythm and style matching are best-effort generative; output duration and sample count are exact.",
    schema: {
      book_id: z.string().describe("Book UUID"),
      asset_id: z.string().describe("Source video artifact id"),
      direction: z.string().trim().min(1).max(500).optional().describe("Optional additional musical direction"),
    },
    handler: async (args) => {
      if (!getApiKey("ELEVENLABS_API_KEY")) {
        return toolError("ELEVENLABS_API_KEY environment variable is not set or is a placeholder");
      }

      const { asset_id, book_id, direction } = args as {
        asset_id: string;
        book_id: string;
        direction?: string;
      };
      const sourceAssetId = asset_id.replace(/^@/u, "");
      const sourceArtifact = fs.artifacts.get(sourceAssetId);
      if (!sourceArtifact.ok) return toolError(sourceArtifact.error.message);
      if (sourceArtifact.value.kind !== "video") {
        return toolError(`replicate_song requires video media; ${sourceAssetId} is ${sourceArtifact.value.kind}`);
      }

      const manifest = await fs.files.manifest(sourceAssetId);
      if (!manifest.ok) return toolError(manifest.error.message);
      const sourceFile = findVideoFile(manifest.value.files);
      if (!sourceFile) return toolError(`No video file found in artifact ${sourceAssetId}`);

      let targetDurationMs: number;
      try {
        const probe = await probeVideo(join(manifest.value.path, sourceFile.name));
        if (probe.videoStream === null || probe.videoCodec === null) {
          return toolError(`Video file ${sourceFile.name} has no video stream`);
        }
        if (!probe.hasAudio || probe.audioStream === null) {
          return toolError(`Video file ${sourceFile.name} has no audio stream`);
        }
        if (!Number.isFinite(probe.videoDuration) || probe.videoDuration <= 0) {
          return toolError(`Could not determine a valid video duration for ${sourceAssetId}`);
        }
        targetDurationMs = Math.round(probe.videoDuration * 1000);
      } catch (error) {
        return toolError(`Failed to probe ${sourceAssetId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (targetDurationMs < MIN_SOURCE_DURATION_MS || targetDurationMs > MAX_SOURCE_DURATION_MS) {
        return toolError(
          `replicate_song requires a video duration between 10.000s and 30.000s inclusive; got ${(targetDurationMs / 1000).toFixed(3)}s`,
        );
      }

      const created = await fs.artifacts.create(
        "audio",
        replicatedSongLabel(sourceArtifact.value),
      );
      if (!created.ok) return toolError(`Failed to create audio asset: ${created.error.message}`);

      const jobId = `replicate-song-${created.value.artifactId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_replicated_song",
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
            source_video: sourceAssetId,
            duration_seconds: targetDurationMs / 1000,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
