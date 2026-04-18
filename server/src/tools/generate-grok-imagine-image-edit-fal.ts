import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { FalXaiGrokImagineImageEditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const base = FalXaiGrokImagineImageEditRequestSchema.shape;
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];
const outputFormatOptions = base.output_format.unwrap().options as readonly [string, ...string[]];

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Edit instruction"),
  image_slugs: z.array(z.string()).min(1).max(3).describe("1-3 @img-* slugs for reference images"),
  num_images: z.number().int().min(1).max(4).optional().describe("Number of images to generate (1-4)"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution"),
  output_format: z.enum(outputFormatOptions).optional().describe("Output image format"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGrokImagineImageEditFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_grok_imagine_image_edit_fal",
    description: "Edit images via fal.ai using xAI Grok Imagine Image edit with 1-3 @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, num_images, resolution, output_format } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.createAsset("img", `grok-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "fal_grok_imagine_image_edit",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, sourceImageId: resolved.sourceImageIds[0], sourceImageIds: resolved.sourceImageIds },
      });

      const jobId = `fal-grok-imagine-image-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_image_edit_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
