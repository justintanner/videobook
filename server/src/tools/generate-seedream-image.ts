import { modelSlug } from "@apicity/cost";
import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { SeedreamImageToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { resolveImageRefs } from "./_image-inputs.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const seedreamInputSchema = SeedreamImageToImageRequestSchema.shape.input.shape;

const generateSeedreamImageSchema = {
  prompt: apicityStringField(seedreamInputSchema.prompt, "Modification prompt (3-3000 chars)", { required: true }),
  book_id: z.string().describe("Book id"),
  image_refs: apicityStringArrayField(seedreamInputSchema.image_urls, "1-14 image artifact ids for reference images", { required: true }),
  aspect_ratio: apicityField(seedreamInputSchema.aspect_ratio, "Output aspect ratio (default 16:9)"),
  quality: apicityField(seedreamInputSchema.quality, "Output quality (basic=2K, high=4K)", { required: true }),
  nsfw_checker: apicityField(seedreamInputSchema.nsfw_checker, "Content safety filter"),

  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'fal')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedreamImageSchema>;

export function generateSeedreamImageDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_seedream_v5_lite_image_to_image",
    description: "Edit or compose images using ByteDance Seedream 5 Lite via Kie with 1-14 image artifact reference inputs. Creates a new image artifact and enqueues a background job.",
    schema: generateSeedreamImageSchema,
    handler: async (args) => {
      const { prompt, book_id, image_refs, aspect_ratio, quality, nsfw_checker } = args as Args;
      const prefix = "img";

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const rawSlugs = image_refs ?? [];

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

      const resolved = await resolveImageRefs(engine, rawSlugs);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = generationLabel(modelSlug("kie", "seedream/5-lite-image-to-image"), prompt);
      const assetResult = await engine.artifacts.create(prefix, assetName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

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
