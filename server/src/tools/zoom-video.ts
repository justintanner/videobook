import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { z } from "zod";
import { probeVideo } from "../ffmpeg.js";
import { checkZoomSounds, zoomPlanFor, type ZoomRequest, type ZoomVideoResult } from "../jobs/zoom-video.js";
import { queue } from "../queue.js";
import { BUILTIN_SOUND_IDS } from "../sound-effects/catalog.js";
import type { ToolDef } from "./tool-def.js";

const JOB_TIMEOUT_MS = 1_800_000;

const zoomSchema = z.object({
  start_seconds: z.number().describe("When the picture starts to zoom in, in seconds"),
  end_seconds: z.number().optional().describe("When the picture is back to normal; omit it to stay zoomed to the end of the clip"),
  scale: z.number().optional().describe("Magnification at full zoom, from 1.05 to 3 (default 1.3)"),
  focus_x: z.number().optional().describe("Point to zoom toward, from 0 (left edge) to 1 (right edge) (default 0.5)"),
  focus_y: z.number().optional().describe("Point to zoom toward, from 0 (top edge) to 1 (bottom edge) (default 0.5)"),
  ramp_in_seconds: z.number().optional().describe("Seconds the way in takes, from 0 (a hard cut) to 5 (default 0.3)"),
  ramp_out_seconds: z.number().optional().describe("Seconds the way back takes, from 0 (a hard cut) to 5 (default 0.3)"),
  sound: z.enum(BUILTIN_SOUND_IDS).optional().describe("Built-in sound that lands as the zoom reaches full scale"),
  return_sound: z.enum(BUILTIN_SOUND_IDS).optional().describe("Built-in sound that starts as the way back begins; needs end_seconds"),
});

function errorResult(text: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text }] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function zoomVideoDef(engine: Engine): ToolDef {
  return {
    name: "zoom_video",
    description: "Zoom in on parts of a video toward a focus point, easing in, holding and returning, with an optional built-in sound. Local and free: one FFmpeg encode in place, with history.",
    schema: {
      asset_id: z.string().describe("Video asset ID"),
      book_id: z.string().describe("Book id"),
      zooms: z.array(zoomSchema).describe("One to eight zooms that do not overlap"),
    },
    handler: async (args) => {
      const assetId = String(args.asset_id).replace(/^@/u, "");
      const zooms = args.zooms as ZoomRequest[];
      const manifest = await engine.files.manifest(assetId);
      if (!manifest.ok) return errorResult(manifest.error.message);
      const videoFile = findVideoFile(manifest.value.files);
      if (!videoFile) return errorResult(`No video file found in asset ${assetId}`);
      const inputPath = join(manifest.value.path, videoFile.name);
      try {
        const source = await probeVideo(inputPath);
        if (source.videoCodec === null) return errorResult(`No usable video stream found in asset ${assetId}`);
        checkZoomSounds(zooms);
        zoomPlanFor(source, zooms);
      } catch (error) {
        return errorResult(messageOf(error));
      }
      const cleared = await engine.jobs.failures.clear(assetId);
      if (!cleared.ok) return errorResult(cleared.error.message);
      const jobId = `zoom-${assetId}-${Date.now()}`;
      try {
        const result = await queue.enqueueAndWait<ZoomVideoResult>(jobId, {
          type: "zoom_video",
          inputPath,
          zooms,
          assetId,
          assetDir: manifest.value.path,
          bookId: args.book_id,
        }, JOB_TIMEOUT_MS);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id: assetId, job_id: jobId, status: "completed", zooms: result.zooms, sounds: result.sounds }),
          }],
        };
      } catch (error) {
        return errorResult(`Zoom failed: ${messageOf(error)}`);
      }
    },
  };
}
