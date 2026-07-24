import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";
import { parseTime } from "../time-parse.js";

export function padVideoDef(fs: Engine): ToolDef {
  return {
    name: "pad_video",
    description: "Append black video frames at the end to make a whole-second video tail. Retains original audio and makes the appended tail silent.",
    schema: {
      asset_id: z.string().describe("Source video asset ID"),
      project_slug: z.string().describe("Project slug"),
      padding: z.string().describe("Padding duration (e.g. 2s)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, padding } = args as {
        asset_id: string;
        project_slug: string;
        padding: string;
      };

      const paddingSecs = parseTime(padding);
      if (paddingSecs === undefined || paddingSecs <= 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid padding duration: ${padding}` }],
        };
      }

      const manifestResult = await fs.files.manifest(asset_id, project_slug);
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

      const sourcePath = join(manifest.path, videoFile.name);

      let sourceDurationSec: number;
      let hasAudio: boolean;
      try {
        const probe = await probeVideo(sourcePath);
        sourceDurationSec = probe.duration;
        hasAudio = probe.hasAudio;
      } catch (err) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Failed to probe source duration: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }

      const unroundedTarget = sourceDurationSec + paddingSecs;
      const EPSILON = 1e-4;
      const targetSecs = Math.ceil(unroundedTarget - EPSILON);

      const jobId = `pad-video-${asset_id}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "pad_video",
        sourcePath,
        assetDir: manifest.path,
        sourceAssetId: asset_id,
        projectSlug: project_slug,
        targetSecs,
        hasAudio,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source_asset_id: asset_id,
            source_duration_sec: sourceDurationSec,
            padding_sec: paddingSecs,
            target_sec: targetSecs,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
