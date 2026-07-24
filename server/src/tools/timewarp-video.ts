import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { join } from "node:path";
import { z } from "zod";
import { probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { createTimewarpPlan } from "../timewarp.js";
import type { ToolDef } from "./tool-def.js";

function errorResult(message: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function timewarpVideoDef(fs: Engine): ToolDef {
  return {
    name: "timewarp_video",
    description: "Retime one video range and compensate the remaining picture to preserve the original duration and audio.",
    schema: {
      asset_id: z.string().describe("Video asset ID"),
      project_slug: z.string().describe("Project slug"),
      start_seconds: z.number().describe("Selected range start in seconds"),
      end_seconds: z.number().describe("Selected range end in seconds"),
      stretch_factor: z.number().describe("Duration multiplier from 0.25 to 4; values above 1 lengthen the selection"),
    },
    handler: async (args) => {
      const {
        asset_id,
        project_slug,
        start_seconds,
        end_seconds,
        stretch_factor,
      } = args as {
        asset_id: string;
        project_slug: string;
        start_seconds: number;
        end_seconds: number;
        stretch_factor: number;
      };

      const manifestResult = await fs.files.manifest(asset_id, project_slug);
      if (!manifestResult.ok) return errorResult(manifestResult.error.message);
      const videoFile = findVideoFile(manifestResult.value.files);
      if (!videoFile) return errorResult(`No video file found in asset ${asset_id}`);

      const inputPath = join(manifestResult.value.path, videoFile.name);
      let source;
      try {
        source = await probeVideo(inputPath);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      if (source.videoCodec === null) {
        return errorResult(`No usable video stream found in asset ${asset_id}`);
      }

      let plan;
      try {
        plan = createTimewarpPlan({
          sourceDuration: source.duration,
          sourceFps: source.fps,
          startSeconds: start_seconds,
          endSeconds: end_seconds,
          stretchFactor: stretch_factor,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }

      const now = Date.now();
      const jobId = `timewarp-${asset_id}-${now}`;
      const outputPath = join(manifestResult.value.path, `.timewarp-${now}.mp4`);
      await queue.enqueue(jobId, {
        type: "timewarp_video",
        inputPath,
        outputPath,
        startSeconds: start_seconds,
        endSeconds: end_seconds,
        stretchFactor: stretch_factor,
        assetId: asset_id,
        assetDir: manifestResult.value.path,
        projectSlug: project_slug,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            job_id: jobId,
            status: "enqueued",
            source_duration: plan.sourceDuration,
            selected_output_duration: plan.selectedOutputDuration,
            outside_stretch_factor: plan.outsideStretchFactor,
          }),
        }],
      };
    },
  };
}
