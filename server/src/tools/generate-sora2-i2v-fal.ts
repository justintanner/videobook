import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { FalSora2ImageToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const base = FalSora2ImageToVideoRequestSchema.shape;
const modelOptions = base.model.unwrap().options as readonly [string, ...string[]];
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];
const aspectRatioOptions = base.aspect_ratio.unwrap().options as readonly [string, ...string[]];

const generateSora2I2vFalSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description (max 5000 chars)"),
  first_frame_slug: z.string().describe("First frame image asset (e.g., @img-start)"),
  model: z.enum(modelOptions).optional().describe("Sora 2 model variant"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution"),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio"),
  duration: z.union([z.literal(4), z.literal(8), z.literal(12), z.literal(16), z.literal(20)]).optional().describe("Video duration in seconds"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSora2I2vFalSchema>;

export function generateSora2I2vFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_sora2_i2v_fal",
    description: "Generate a video via fal.ai using OpenAI Sora 2 from a first-frame image. Creates a new vid- asset and enqueues a background job.",
    schema: generateSora2I2vFalSchema,
    handler: async (args) => {
      const { project_slug, prompt, first_frame_slug, model, resolution, aspect_ratio, duration } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, [first_frame_slug], project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame] = resolved.inputs;
      const assetResult = await fs.createAsset("vid", `sora2-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "fal_sora2_i2v",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, mode: "i2v", sourceImageIds: resolved.sourceImageIds },
      });

      const jobId = `fal-sora2-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_sora2_i2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        firstFrame,
        sourceImageIds: resolved.sourceImageIds,
        ...(model !== undefined ? { model } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
