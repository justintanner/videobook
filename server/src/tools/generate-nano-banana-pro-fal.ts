import type { VideocityFs } from "vc-engine";
import { z, type ZodRawShape } from "zod";
import { FalNanoBananaProTextToImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";

const base = FalNanoBananaProTextToImageRequestSchema.shape;
const aspectRatioOptions = base.aspect_ratio.unwrap().options as readonly [string, ...string[]];
const outputFormatOptions = base.output_format.unwrap().options as readonly [string, ...string[]];
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Text prompt for image generation"),
  num_images: z.number().int().optional().describe("Number of images to generate"),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Aspect ratio"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution (1K/2K/4K)"),
  output_format: z.enum(outputFormatOptions).optional().describe("Output image format"),
  seed: z.number().optional().describe("Seed for deterministic output"),
  enable_web_search: z.boolean().optional().describe("Enable web search grounding"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateNanoBananaProFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_nano_banana_pro_fal",
    description: "Generate an image via fal.ai using Google Nano Banana Pro from a text prompt. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, num_images, aspect_ratio, resolution, output_format, seed, enable_web_search } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("img", `${modelSlug("kie", "nano-banana-pro")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "nano-banana-pro")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_nano_banana_pro_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(enable_web_search !== undefined ? { enable_web_search } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
