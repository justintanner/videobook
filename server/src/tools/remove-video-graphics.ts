import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { renderRequestStatus } from "../render-requests.js";
import { cleanupMethodSchema, cleanupRegionsSchema, type CleanupMethod, type CleanupRegion } from "../video-cleanup/model.js";
import { readCleanup, readCleanupRequest, requestCleanupDetection, requestCleanupRender } from "../video-cleanup/service.js";
import type { ToolDef } from "./tool-def.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";

export function removeVideoGraphicsDef(engine: Engine): ToolDef {
  return {
    name: "remove_video_graphics",
    description: "Locally detect burned-in titles/text, review timed regions and remove OSG, logos or text into a new video copy. get reads source/model/detection state; install_models downloads 213 MB once; detect samples local text candidates (review scene text and add non-text logos manually); render uses reviewed regions. LaMa is frame-by-frame AI inpainting and may flicker; fill is fast interpolation for simple backgrounds. No media upload or API key.",
    schema: {
      book_id: z.string(),
      asset_id: z.string().describe("Video artifact ID or grid address"),
      notebook_id: z.string().optional(),
      op: z.enum(["get", "install_models", "detect", "render", "status"]),
      sample_interval: z.number().min(0.25).max(30).optional().describe("Detection sampling interval in seconds; default 0.5, increased for long clips"),
      force: z.boolean().optional(),
      regions: cleanupRegionsSchema.optional().describe("Reviewed rectangles, coordinates 0–1 from top left; start/end in seconds"),
      method: cleanupMethodSchema.optional().describe("lama (default) or fast fill"),
      source_hash: z.string().optional().describe("Source hash returned by get; required for render"),
      request_id: z.string().uuid().optional().describe("Unique request ID for idempotent render submission and status"),
      job_id: z.number().int().positive().optional().describe("Model installation job to inspect or cancel with cancel_job"),
    },
    handler: async (args) => {
      try {
        const notebookId = typeof args.notebook_id === "string" ? args.notebook_id : undefined;
        const assetId = resolveVideoAssetReference(engine, String(args.asset_id), notebookId);
        const bookId = String(args.book_id);
        let result: unknown;
        if (args.op === "install_models") {
          const job = await queue.enqueue("install-video-cleanup-models", { type: "install_video_cleanup_models", bookId });
          result = { job_id: job.id, status: job.state };
        } else if (args.op === "status") {
          const request = typeof args.request_id === "string" ? readCleanupRequest(engine, args.request_id) : null;
          if (request) {
            if (request.sourceArtifactId !== assetId) throw new Error("This removal belongs to another video.");
            result = renderRequestStatus(engine, request);
          } else {
            const job = typeof args.job_id === "number" ? engine.jobs.queue.get(args.job_id) : null;
            if (!job || job.type !== "install_video_cleanup_models") throw new Error("Removal or model installation job not found.");
            result = { job_id: job.id, status: job.state, error: job.error?.message ?? null };
          }
        } else if (args.op === "detect") {
          result = await requestCleanupDetection(engine, bookId, assetId, args.sample_interval as number | undefined, args.force === true);
        } else if (args.op === "render") {
          if (!args.request_id || !args.source_hash || !args.regions) throw new Error("render requires request_id, source_hash and reviewed regions.");
          result = await requestCleanupRender(engine, bookId, assetId, {
            requestId: String(args.request_id), sourceHash: String(args.source_hash), notebookId: notebookId ?? null,
            method: (args.method ?? "lama") as CleanupMethod, regions: args.regions as CleanupRegion[],
          });
        } else result = await readCleanup(engine, assetId, args.sample_interval as number | undefined);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  };
}
