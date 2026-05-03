import type { ClipfirstFs } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Text prompt for image generation"),
  image_size: z.enum(["auto_2K", "auto_4K"]).optional().describe("Output size"),
  num_images: z.number().int().optional().describe("Number of images to generate"),
  max_images: z.number().int().optional().describe("Max images returned"),
  seed: z.number().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedreamV5LiteFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedream_v5_lite_fal",
    description: "Generate an image via fal.ai using ByteDance Seedream V5 Lite from a text prompt. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_size, num_images, max_images, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("img", `${modelSlug("kie", "seedream/5-lite-text-to-image")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "seedream/5-lite-text-to-image")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedream_v5_lite_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(image_size !== undefined ? { image_size } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(max_images !== undefined ? { max_images } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
