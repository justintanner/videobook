import type { Artifact, Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import { probeVideo, type ProbeResult } from "../ffmpeg.js";
import { validateMediaOutputPaths } from "../media-output-path.js";
import type { ToolDef } from "./tool-def.js";

function deriveAudioName(source: Artifact): string {
  return `ext-${source.label ?? source.artifactId}`;
}

export function extractAudioDef(engine: Engine): ToolDef {
  return {
    name: "extract_audio",
    description: "Extract a video's audio as MP3 into a new audio asset, or as a file inside an existing asset with destination. range limits it to a time window.",
    schema: {
      asset_id: z.string().describe("Video artifact id"),
      book_id: z.string().describe("Book UUID"),
      destination: z
        .object({
          asset_id: z.string().describe("Existing artifact id to write the mp3 into"),
          filename: z.string().describe("Filename for the mp3 inside the destination asset (e.g. \"s1.mp3\")"),
        })
        .optional()
        .describe(
          "When set, write the mp3 to <destination.asset_id>/<destination.filename> instead of minting a fresh audio asset.",
        ),
      range: z
        .object({
          start_s: z.number().min(0).describe("Start offset in seconds (inclusive)"),
          duration_s: z.number().positive().describe("Duration in seconds"),
        })
        .optional()
        .describe(
          "When set, extract only this time window from the source.",
        ),
    },
    handler: async (args) => {
      const { asset_id, book_id, destination, range } = args as {
        asset_id: string;
        book_id: string;
        destination?: { asset_id: string; filename: string };
        range?: { start_s: number; duration_s: number };
      };
      const sourceArtifact = engine.artifacts.get(asset_id);
      if (!sourceArtifact.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: sourceArtifact.error.message }],
        };
      }
      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const videoPath = join(manifest.path, videoFile.name);

      let probe: ProbeResult;
      try {
        probe = await probeVideo(videoPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to probe video: ${msg}` }],
        };
      }

      if (!probe.hasAudio) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Video has no audio stream: ${asset_id}` }],
        };
      }
      const audioDuration = probe.audioDuration ?? probe.duration;
      if (range && (!Number.isFinite(audioDuration) || range.start_s >= audioDuration)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Audio range must start before the source audio ends." }],
        };
      }

      let audioAssetId: string;
      let audioAssetDir: string;
      let outputPath: string;
      const destinationMode = destination !== undefined;

      if (destination !== undefined) {
        try {
          [destination.filename] = await validateMediaOutputPaths(engine, destination.asset_id, [destination.filename], ".mp3");
        } catch (error) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          };
        }
        const destManifest = await engine.files.manifest(destination.asset_id);
        if (!destManifest.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Destination asset ${destination.asset_id} not found: ${destManifest.error.message}` }],
          };
        }
        audioAssetId = destination.asset_id;
        audioAssetDir = destManifest.value.path;
        outputPath = join(audioAssetDir, destination.filename);
      } else {
        const audioName = deriveAudioName(sourceArtifact.value);
        const assetResult = await engine.artifacts.create("audio", audioName);
        if (!assetResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Failed to create audio asset: ${assetResult.error.message}` }],
          };
        }
        audioAssetId = assetResult.value.artifactId;
        audioAssetDir = assetResult.value.path;
        outputPath = join(audioAssetDir, "original.mp3");
      }

      const jobId = `extract-audio-${audioAssetId}-${Date.now()}`;
      const payload = {
        type: "extract_audio",
        inputPath: videoPath,
        outputPath,
        audioAssetId,
        audioAssetDir,
        sourceVideoId: asset_id,
        bookId: book_id,
        destination: destinationMode ? { filename: destination!.filename } : undefined,
        range,
      } as unknown as Record<string, unknown>;

      // Destination mode synchronously awaits the ffmpeg + commit so the
      // caller (PlanViewer bootstrap) knows the file is on disk before
      // gating RUN VIDEO. The auto-mint path keeps fire-and-forget so the
      // sidebar shows a pending aud-* tile while the job runs.
      if (destinationMode) {
        try {
          await queue.enqueueAndWait(jobId, payload);
        } catch (err) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Audio extract failed: ${err instanceof Error ? err.message : String(err)}`,
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              destination: { asset_id: audioAssetId, filename: destination!.filename },
              source_video: asset_id,
              job_id: jobId,
              status: "completed",
            }),
          }],
        };
      }

      await queue.enqueue(jobId, payload);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            audio_asset_id: audioAssetId,
            source_video: asset_id,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
