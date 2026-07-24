import { modelSlug } from "@apicity/cost";
import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { SeedreamImageToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { resolveImageSlugs } from "./_image-inputs.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const seedreamInputSchema = SeedreamImageToImageRequestSchema.shape.input.shape;

const generateSeedreamImageSchema = {
  prompt: apicityStringField(seedreamInputSchema.prompt, "Modification prompt (3-3000 chars)", { required: true }),
  book_id: z.string().describe("Project slug"),
  image_slugs: apicityStringArrayField(seedreamInputSchema.image_urls, "1-14 @img-* slugs for reference images", { required: true }),
  aspect_ratio: apicityField(seedreamInputSchema.aspect_ratio, "Output aspect ratio (default 16:9)"),
  quality: apicityField(seedreamInputSchema.quality, "Output quality (basic=2K, high=4K)", { required: true }),
  nsfw_checker: apicityField(seedreamInputSchema.nsfw_checker, "Content safety filter"),

  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'fal')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedreamImageSchema>;

export function generateSeedreamImageDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_seedream_v5_lite_image_to_image",
    description: "Edit or compose images using ByteDance Seedream 5 Lite via Kie with 1-14 @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema: generateSeedreamImageSchema,
    handler: async (args) => {
      const { prompt, book_id, image_slugs, aspect_ratio, quality, nsfw_checker } = args as Args;
      const prefix = "img";

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const rawSlugs = image_slugs ?? [];

      // Apicity schema validation — accept bare IDs (no @ prefix) as stand-ins
      // for URLs; the real URLs are resolved post-upload in the job handler.
      const apicityCheck = SeedreamImageToImageRequestSchema.safeParse({
        model: "seedream/5-lite-image-to-image",
        input: {
          prompt,
          image_urls: rawSlugs.map((s) => s.replace(/^@/, "")),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(quality !== undefined ? { quality } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageSlugs(fs, rawSlugs, book_id);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = `${modelSlug("kie", "seedream/5-lite-image-to-image")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.artifacts.create(prefix, assetName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { slug: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "seedream/5-lite-image-to-image")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedream_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        bookId: book_id,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(nsfw_checker !== undefined ? { nsfwChecker: nsfw_checker } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
