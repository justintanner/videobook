import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { getFFmpeggy } from "../ffmpeg.js";
import { findVideoFile } from "videocity-engine";
import type { ToolDef } from "./tool-def.js";

const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;

function validateSpeed(speed: number): string | null {
  if (speed === 1.0) return "Speed 1.0 is a no-op — nothing to change";
  if (speed < SPEED_MIN || speed > SPEED_MAX) return `Speed must be between ${SPEED_MIN} and ${SPEED_MAX}, got ${speed}`;
  return null;
}

async function probeMedia(filePath: string): Promise<{ hasAudio: boolean; duration: number }> {
  const FFmpeggy = await getFFmpeggy();
  const probe = await FFmpeggy.probe(filePath);
  const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
  const duration = parseFloat(probe.format.duration) || 0;
  return { hasAudio, duration };
}

export function changeVideoSpeedDef(fs: VideocityFs): ToolDef {
  return {
    name: "change_video_speed",
    description: "Change video playback speed (speed up or slow down). Operates in-place with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      speed: z.number().optional().describe("Speed multiplier (0.25–4.0). >1 = faster, <1 = slower."),
      target_duration_seconds: z.number().optional().describe("Exact target output duration in seconds"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, speed: requestedSpeed, target_duration_seconds } = args as { asset_id: string; project_slug: string; speed?: number; target_duration_seconds?: number };
      
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

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);
      
      const { hasAudio, duration } = await probeMedia(videoPath);
      
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
        projectSlug: project_slug,
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

