import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { getFFmpeggy } from "../ffmpeg.js";
import { findVideoFile } from "vc-engine";
import type { ToolDef } from "./tool-def.js";

const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;

function validateSpeed(speed: number): string | null {
  if (speed === 1.0) return "Speed 1.0 is a no-op — nothing to change";
  if (speed < SPEED_MIN || speed > SPEED_MAX) return `Speed must be between ${SPEED_MIN} and ${SPEED_MAX}, got ${speed}`;
  return null;
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  const FFmpeggy = await getFFmpeggy();
  const probe = await FFmpeggy.probe(filePath);
  return probe.streams.some((s) => s.codec_type === "audio");
}

export function changeVideoSpeedDef(fs: VideocityFs): ToolDef {
  return {
    name: "change_video_speed",
    description: "Change video playback speed (speed up or slow down). Operates in-place with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      speed: z.number().describe("Speed multiplier (0.25–4.0). >1 = faster, <1 = slower."),
    },
    handler: async (args) => {
      const { asset_id, project_slug, speed } = args as { asset_id: string; project_slug: string; speed: number };
      const speedError = validateSpeed(speed);
      if (speedError) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: speedError }],
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
      const tempPath = join(assetDir, "original_speed.mp4");
      const jobId = `speed-${asset_id}-${Date.now()}`;

      const hasAudio = await hasAudioStream(videoPath);

      await queue.enqueue(jobId, {
        type: "change_video_speed",
        inputPath: videoPath,
        outputPath: tempPath,
        speed,
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

