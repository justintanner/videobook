import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";

const WAN27_IMAGE_SIZES = ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"] as const;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Text prompt for image generation"),
  negative_prompt: z.string().optional().describe("Negative prompt"),
  image_size: z.enum(WAN27_IMAGE_SIZES).optional().describe("Output size preset"),
  max_images: z.number().int().min(1).max(5).optional().describe("Max images returned (1-5)"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27ProFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_wan27_pro_fal",
    description: "Generate an image via fal.ai using Wan 2.7 Pro text-to-image (higher quality variant). Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, negative_prompt, image_size, max_images, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("img", `wan27pro-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "fal_wan27_pro",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, sourceImageIds: [] },
      });

      const jobId = `fal-wan27-pro-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_pro_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(image_size !== undefined ? { image_size } : {}),
        ...(max_images !== undefined ? { max_images } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
