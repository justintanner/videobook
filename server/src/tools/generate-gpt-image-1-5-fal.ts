import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { FalGptImage1p5RequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";

const base = FalGptImage1p5RequestSchema.shape;
const imageSizeOptions = base.image_size.unwrap().options as readonly [string, ...string[]];
const backgroundOptions = base.background.unwrap().options as readonly [string, ...string[]];
const outputFormatOptions = base.output_format.unwrap().options as readonly [string, ...string[]];
const qualityOptions = base.quality.unwrap().options as readonly [string, ...string[]];

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Text prompt for image generation"),
  image_size: z.enum(imageSizeOptions).optional().describe("Output size"),
  num_images: z.number().int().min(1).max(4).optional().describe("Number of images (1-4)"),
  background: z.enum(backgroundOptions).optional().describe("Background handling"),
  output_format: z.enum(outputFormatOptions).optional().describe("Output image format"),
  quality: z.enum(qualityOptions).optional().describe("Output quality"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGptImage1p5FalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_gpt_image_1_5_fal",
    description: "Generate an image via fal.ai using OpenAI GPT Image 1.5 from a text prompt. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_size, num_images, background, output_format, quality } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("img", `gpt-image-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "fal_gpt_image_1_5",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, sourceImageIds: [] },
      });

      const jobId = `fal-gpt-image-1-5-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_gpt_image_1_5_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(image_size !== undefined ? { image_size } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(background !== undefined ? { background } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(quality !== undefined ? { quality } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
