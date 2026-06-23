import { modelSlug } from "@apicity/cost";
import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { SeedreamTextToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { apicityField } from "./schema-from-apicity.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const seedreamInputSchema = SeedreamTextToImageRequestSchema.shape.input.shape;

const generateSeedreamTextImageSchema = {
  prompt: z.string().describe("Text description of the image to generate (3-3000 chars)"),
  project_slug: z.string().describe("Project slug"),
  aspect_ratio: apicityField(seedreamInputSchema.aspect_ratio, "Output aspect ratio (default 1:1)"),
  quality: apicityField(seedreamInputSchema.quality, "Output quality (basic=2K, high=4K). Defaults to basic."),
  nsfw_checker: z.boolean().optional().describe("Content safety filter"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'fal')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedreamTextImageSchema>;

export function generateSeedreamTextImageDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_seedream_text_image",
    description: "Generate an image from text using ByteDance Seedream 5 Lite via Kie. Creates a new img- asset and enqueues a background job.",
    schema: generateSeedreamTextImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, aspect_ratio, quality, nsfw_checker } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const apicityCheck = SeedreamTextToImageRequestSchema.safeParse({
        model: "seedream/5-lite-text-to-image",
        input: {
          prompt,
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(quality !== undefined ? { quality } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const assetName = `${modelSlug("kie", "seedream/5-lite-text-to-image")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("img", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "seedream/5-lite-text-to-image")}-text-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedream_text_image",
        prompt,
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(nsfw_checker !== undefined ? { nsfwChecker: nsfw_checker } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

