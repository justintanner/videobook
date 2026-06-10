import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { queue } from "../queue.js";
import { findVideoFile } from "videocity-engine";
import type { ToolDef } from "./tool-def.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFPROBE: string = require("ffprobe-static").path;

async function hasAudioStream(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  return (data.streams as Array<Record<string, unknown>>)?.some(
    (s) => s.codec_type === "audio",
  ) ?? false;
}

function deriveAudioName(videoAssetId: string): string {
  const baseName = videoAssetId.startsWith("vid-") ? videoAssetId.slice(4) : videoAssetId;
  return `ext-${baseName}`;
}

export function extractAudioDef(fs: VideocityFs): ToolDef {
  return {
    name: "extract_audio",
    description: "Extract the audio track from a video asset as MP3. By default creates a new aud-* asset with original.mp3; pass `destination` to instead write the mp3 as a sibling file inside an existing asset (e.g. plan/s1.mp3). Pass `range` to clip a specific time window (e.g. one scene's audio from a longer source).",
    schema: {
      asset_id: z.string().describe("Video asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      destination: z
        .object({
          asset_id: z.string().describe("Existing asset to write the mp3 into (e.g. \"plan\")"),
          filename: z.string().describe("Filename for the mp3 inside the destination asset (e.g. \"s1.mp3\")"),
        })
        .optional()
        .describe(
          "When set, write the mp3 to <destination.asset_id>/<destination.filename> instead of minting a fresh aud-* asset.",
        ),
      range: z
        .object({
          start_s: z.number().min(0).describe("Start offset in seconds (inclusive)"),
          duration_s: z.number().positive().describe("Duration in seconds"),
        })
        .optional()
        .describe(
          "When set, extract only this time window from the source. Used by plan-vis bootstrap to produce per-scene mp3s ≤ seedance-2's 15.2s reference cap.",
        ),
    },
    handler: async (args) => {
      const { asset_id, project_slug, destination, range } = args as {
        asset_id: string;
        project_slug: string;
        destination?: { asset_id: string; filename: string };
        range?: { start_s: number; duration_s: number };
      };
      const manifestResult = await fs.getManifest(asset_id, project_slug);
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

      let audioPresent: boolean;
      try {
        audioPresent = await hasAudioStream(videoPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to probe video: ${msg}` }],
        };
      }

      if (!audioPresent) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Video has no audio stream: ${asset_id}` }],
        };
      }

      let audioAssetId: string;
      let audioAssetDir: string;
      let outputPath: string;
      const destinationMode = destination !== undefined;

      if (destination !== undefined) {
        const destManifest = await fs.getManifest(destination.asset_id, project_slug, { includeDotfiles: true });
        if (!destManifest.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Destination asset ${destination.asset_id} not found: ${destManifest.error.message}` }],
          };
        }
        const exists = destManifest.value.files.some((f) => f.name === destination.filename);
        if (exists) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Destination already contains ${destination.filename}. Refusing silent overwrite.`,
            }],
          };
        }
        audioAssetId = destination.asset_id;
        audioAssetDir = destManifest.value.path;
        outputPath = join(audioAssetDir, destination.filename);
      } else {
        const audioName = deriveAudioName(asset_id);
        const assetResult = await fs.createAsset("aud", audioName, project_slug);
        if (!assetResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Failed to create audio asset: ${assetResult.error.message}` }],
          };
        }
        audioAssetId = assetResult.value.assetId;
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
        projectSlug: project_slug,
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

