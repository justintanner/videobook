import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { FalGptImage1p5EditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const base = FalGptImage1p5EditRequestSchema.shape;
const imageSizeOptions = base.image_size.unwrap().options as readonly [string, ...string[]];
const backgroundOptions = base.background.unwrap().options as readonly [string, ...string[]];
const qualityOptions = base.quality.unwrap().options as readonly [string, ...string[]];
const inputFidelityOptions = base.input_fidelity.unwrap().options as readonly [string, ...string[]];
const outputFormatOptions = base.output_format.unwrap().options as readonly [string, ...string[]];

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Edit instruction"),
  image_slugs: z.array(z.string()).min(1).describe("1 or more @img-* slugs for reference images"),
  image_size: z.enum(imageSizeOptions).optional().describe("Output size"),
  background: z.enum(backgroundOptions).optional().describe("Background handling"),
  quality: z.enum(qualityOptions).optional().describe("Output quality"),
  num_images: z.number().int().min(1).max(4).optional().describe("Number of images (1-4)"),
  input_fidelity: z.enum(inputFidelityOptions).optional().describe("Input fidelity"),
  output_format: z.enum(outputFormatOptions).optional().describe("Output image format"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGptImage1p5EditFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_gpt_image_1_5_edit_fal",
    description: "Edit images via fal.ai using OpenAI GPT Image 1.5 with one or more @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, image_size, background, quality, num_images, input_fidelity, output_format } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.createAsset("img", `gpt-image-edit-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "fal_gpt_image_1_5_edit",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, sourceImageIds: resolved.sourceImageIds },
      });

      const jobId = `fal-gpt-image-1-5-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_gpt_image_1_5_edit_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(image_size !== undefined ? { image_size } : {}),
        ...(background !== undefined ? { background } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(input_fidelity !== undefined ? { input_fidelity } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
