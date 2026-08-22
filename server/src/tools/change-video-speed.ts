import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import { findVideoFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;

function validateSpeed(speed: number): string | null {
  if (speed === 1.0) return "Speed 1.0 is a no-op — nothing to change";
  if (speed < SPEED_MIN || speed > SPEED_MAX) return `Speed must be between ${SPEED_MIN} and ${SPEED_MAX}, got ${speed}`;
  return null;
}

export function changeVideoSpeedDef(engine: Engine): ToolDef {
  return {
    name: "change_video_speed",
    description: "Change video playback speed (speed up or slow down). Operates in-place with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      book_id: z.string().describe("Book id"),
      speed: z.number().optional().describe("Speed multiplier (0.25–4.0). >1 = faster, <1 = slower."),
      target_duration_seconds: z.number().optional().describe("Exact target output duration in seconds"),
    },
    handler: async (args) => {
      const { asset_id, book_id, speed: requestedSpeed, target_duration_seconds } = args as { asset_id: string; book_id: string; speed?: number; target_duration_seconds?: number };
      
      if ((requestedSpeed === undefined && target_duration_seconds === undefined) || (requestedSpeed !== undefined && target_duration_seconds !== undefined)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Must provide exactly one of speed or target_duration_seconds" }],
        };
      }
      
      if (target_duration_seconds !== undefined && (target_duration_seconds <= 0 || !Number.isFinite(target_duration_seconds))) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Target duration must be a positive finite number, got ${target_duration_seconds}` }],
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

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);
      
      const probe = await probeVideo(videoPath);
      const { hasAudio } = probe;
      // Exact-duration mode derives the multiplier from the video stream, not
      // the container: format duration follows the longest stream, so a
      // longer audio track would under-speed the video and leave it short of
      // the target (and the duration cap would clip a longer video stream's
      // tail).
      const duration = probe.videoDuration;
      
      let speed: number;
      if (target_duration_seconds !== undefined) {
        if (duration <= 0) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Failed to probe source duration for asset ${asset_id}` }],
          };
        }
        speed = duration / target_duration_seconds;
      } else {
        speed = requestedSpeed!;
      }

      const speedError = validateSpeed(speed);
      if (speedError) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: speedError }],
        };
      }

      const tempPath = join(assetDir, "original_speed.mp4");
      const jobId = `speed-${asset_id}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "change_video_speed",
        inputPath: videoPath,
        outputPath: tempPath,
        speed,
        targetDuration: target_duration_seconds,
        hasAudio,
        assetId: asset_id,
        assetDir,
        bookId: book_id,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

